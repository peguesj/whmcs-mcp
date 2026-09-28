/**
 * test/mock-whmcs-server.ts
 *
 * A synthetic, in-process fake of the WHMCS External API endpoint
 * (`{WHMCS_API_URL}/includes/api.php`) built on Node's built-in `node:http`
 * — no test-only HTTP framework dependency, per DRTW L2 (platform-native
 * capability first).
 *
 * This is the ONLY place in the repo that is allowed to contain fixture
 * data shaped like WHMCS records. Every value below is fabricated
 * (`example.test` domains, `@example.test` emails, fake names/amounts) —
 * never copy real client data into this file, because:
 *   1. `scripts/capture-screenshots.ts` points the MCP Inspector at this
 *      server and the resulting PNGs are published to the public GitHub
 *      Pages marketing site (site/assets/screenshots/).
 *   2. `test/*.test.ts` asserts against these exact fixture shapes.
 *
 * Responsibilities:
 *   - Speaks the real WHMCS External API contract: a single endpoint that
 *     accepts a form-urlencoded POST per call, where the `action` field
 *     selects the operation, auth travels IN the body as `identifier` +
 *     `secret` (+ optional `accesskey`), and the response is a uniform
 *     JSON envelope (`result: "success" | "error"`). See
 *     src/whmcs-client.ts's header comment for the full contract note —
 *     this file mirrors it so tests exercise the real shape, not an
 *     idealized one.
 *   - Rejects bad credentials the way WHMCS actually does: HTTP 200 with
 *     `{ result: "error", message: "..." }` in the body, NOT an HTTP 401.
 *     (WHMCS's External API does not use HTTP status codes to signal auth
 *     failure — src/whmcs-client.ts's WhmcsApiError mapping depends on
 *     this, so the mock must reproduce it faithfully.)
 *   - Wraps every repeating collection in WHMCS's documented singular-key
 *     nesting (e.g. `{ tickets: { ticket: [...] } }`), including the
 *     "single result drops the array" quirk, so
 *     `src/whmcs-client.ts#unwrapCollection` is exercised against the real
 *     shape rather than a pre-flattened one.
 *   - Records every call it receives (action + params, with `secret`
 *     always redacted before storage) so tests can assert on what was
 *     actually sent — including that `identifier`/`secret` were present
 *     and correct, and that mutating tools never fire before a
 *     confirmToken is supplied.
 *   - Never logs or echoes the real `secret`/`accesskey` it was configured
 *     with — `recordedCalls` and any console output redact them.
 *
 * Non-goals: this is not a WHMCS emulator. It implements exactly the
 * action set in the architecture plan's `toolList` (see file header cross
 * references below), with plausible-but-fake data, and a small generic
 * escape hatch for actions not yet fixtured. It has no persistence across
 * calls beyond `recordedCalls` — mutating actions do not actually mutate
 * the fixture data, they just return a success envelope, because the goal
 * is contract-shape testing and deterministic screenshots, not a full
 * WHMCS simulation.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Credentials the mock server will accept. Defaults are obviously-fake placeholders. */
export interface MockWhmcsCredentials {
  identifier: string;
  secret: string;
  /** Optional WHMCS "Access Key" (General Settings > Security). Omit to not require one. */
  accessKey?: string;
}

export const DEFAULT_MOCK_CREDENTIALS: Readonly<MockWhmcsCredentials> = Object.freeze({
  identifier: "mock_identifier_do_not_use",
  secret: "mock_secret_do_not_use_in_prod",
});

export interface MockWhmcsServerOptions {
  /** Credentials the server requires. Defaults to DEFAULT_MOCK_CREDENTIALS. */
  credentials?: MockWhmcsCredentials;
  /** Port to bind. Default 0 (OS-assigned ephemeral port — safe for parallel test runs). */
  port?: number;
  /** Host to bind. Default "127.0.0.1". */
  host?: string;
  /**
   * Artificial per-request delay in ms, to make MCP Inspector screenshots
   * show a believable "loading" state. Default 0 (instant, for unit tests).
   */
  latencyMs?: number;
  /**
   * Additional/override fixture functions, keyed by WHMCS action name.
   * Merged over the built-in FIXTURES so a test can stub one action
   * (e.g. to simulate a paginated second page) without reimplementing
   * the rest of the server.
   */
  fixtureOverrides?: Partial<FixtureMap>;
}

/** One recorded inbound call. `secret` is always redacted before storage. */
export interface RecordedCall {
  action: string;
  /** Form params exactly as received, EXCEPT `secret` is replaced with "[REDACTED]". */
  params: Record<string, string>;
  receivedAt: number;
}

/**
 * A raw, low-level record of one inbound HTTP request, kept in addition to
 * `RecordedCall` for contract tests that need to assert on transport
 * details a fixture-oriented `RecordedCall` doesn't carry (exact headers,
 * the unparsed body, the request path). Used by `lastRequest()` /
 * `requestCount()`. `rawBody` intentionally is NOT redacted (contract tests
 * assert `secret` IS present in the body, to prove it travels there and
 * not in a header) — callers that log this must redact it themselves, the
 * way `src/logger.ts` is required to.
 */
export interface RawRequestRecord {
  method: string;
  /** Request path as received, e.g. "/includes/api.php". Never contains credentials (those are body-only). */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  receivedAt: number;
}

/**
 * A response a test has pre-queued via `queueResponse()`. While the queue
 * is non-empty, each inbound request consumes exactly one queued response
 * IN ORDER and returns it verbatim — bypassing auth checking and fixture
 * lookup entirely. This is how contract tests script exact HTTP-level
 * conditions (a bare 500, a 429, a non-JSON body, a sequence of "fail then
 * succeed" for retry tests) without needing a bespoke fixture per scenario.
 * The request is still recorded in `calls` / `rawRequests` as normal.
 */
export interface QueuedResponse {
  /** HTTP status code to respond with. Default 200. */
  status?: number;
  /** JSON body to send. Mutually exclusive with `rawBody` — `body` takes precedence if both are given. */
  body?: Record<string, unknown>;
  /** Raw (non-JSON) response body, e.g. to simulate WHMCS returning HTML on a misconfigured URL. */
  rawBody?: string;
  /** Response Content-Type. Defaults to "application/json; charset=utf-8" when `body` is set, else "text/plain". */
  contentType?: string;
  /**
   * Artificial delay (ms) before this specific queued response is sent,
   * applied in addition to the server-wide `latencyMs` option. Used by
   * timeout contract tests to simulate a WHMCS response that arrives after
   * the client's configured `timeoutMs` has elapsed, without slowing down
   * every other test via the server-wide latency knob.
   */
  delayMs?: number;
}

export interface MockWhmcsServer {
  readonly server: Server;
  readonly port: number;
  readonly host: string;
  /** Base URL to hand to WHMCS_API_URL — i.e. the install root, NOT including /includes/api.php. */
  readonly url: string;
  /** Every call received so far, oldest first (fixture-oriented view: action + redacted params). */
  readonly calls: RecordedCall[];
  /** Alias of `calls`, for call sites that read it as a log rather than a list. */
  readonly callLog: RecordedCall[];
  /** Clears `calls`/`callLog` without restarting the server. */
  reset(): void;
  /** Alias of `reset()`. */
  resetCallLog(): void;
  /**
   * Pushes one scripted response onto the FIFO queue consumed by the next
   * inbound request(s), for exercising exact HTTP-level behavior (a 500, a
   * 429, non-JSON, a partial failure sequence) that the fixture map does
   * not attempt to model. See `QueuedResponse`.
   */
  queueResponse(response: QueuedResponse): void;
  /** The most recent inbound HTTP request (raw, unparsed), or undefined if none has arrived yet. */
  lastRequest(): RawRequestRecord | undefined;
  /** Total number of inbound HTTP requests received so far. */
  requestCount(): number;
  /** Stops listening and releases the port. */
  close(): Promise<void>;
}

/** Signature every fixture function implements. Return value is spread into `{ result: "success", ... }`. */
export type FixtureFn = (params: URLSearchParams) => Record<string, unknown>;
export type FixtureMap = Record<string, FixtureFn>;

// ---------------------------------------------------------------------------
// Synthetic fixture data
//
// Everything below is fabricated for testing/screenshots. Domains use the
// IANA-reserved `example.test` / `example.com` TLDs; emails use
// `@example.test`; names, phone numbers, and amounts are placeholders.
// ---------------------------------------------------------------------------

const NOW_ISO = "2026-09-28T00:00:00Z";

const FIXTURE_TICKETS = [
  {
    id: "1001",
    tid: "TCK-1001",
    deptid: "1",
    deptname: "Technical Support",
    userid: "501",
    contactid: "0",
    name: "Jordan Rivera",
    email: "jordan.rivera@example.test",
    subject: "Cannot reach the customer portal",
    status: "Open",
    priority: "Medium",
    admin: "",
    date: "2026-09-27 14:02:11",
    lastreply: "2026-09-27 15:10:44",
    flag: "0",
    replies: {
      reply: [
        {
          id: "9001",
          message: "I'm getting a 502 when I log in. Can you check?",
          admin: "",
          fullname: "Jordan Rivera",
          email: "jordan.rivera@example.test",
          date: "2026-09-27 14:02:11",
          attachments: "",
        },
        {
          id: "9002",
          message: "Looking into it now, thanks for the report.",
          admin: "1",
          fullname: "Sam Ortiz",
          email: "sam.ortiz@example.test",
          date: "2026-09-27 15:10:44",
          attachments: "",
        },
      ],
    },
  },
  {
    id: "1002",
    tid: "TCK-1002",
    deptid: "2",
    deptname: "Billing",
    userid: "502",
    contactid: "0",
    name: "Priya Natarajan",
    email: "priya.natarajan@example.test",
    subject: "Question about invoice INV-2044",
    status: "Answered",
    priority: "Low",
    admin: "1",
    date: "2026-09-25 09:30:00",
    lastreply: "2026-09-25 11:00:00",
    flag: "0",
    replies: { reply: [] },
  },
] as const;

const FIXTURE_CLIENTS = [
  {
    id: "501",
    firstname: "Jordan",
    lastname: "Rivera",
    companyname: "Rivera Consulting LLC",
    email: "jordan.rivera@example.test",
    address1: "123 Placeholder Ave",
    city: "Springfield",
    state: "IL",
    postcode: "62701",
    country: "US",
    phonenumber: "+15555550100",
    status: "Active",
    groupid: "0",
    credit: "0.00",
    currency: "1",
    defaultgateway: "mock-gateway",
  },
  {
    id: "502",
    firstname: "Priya",
    lastname: "Natarajan",
    companyname: "",
    email: "priya.natarajan@example.test",
    address1: "456 Sample Blvd",
    city: "Austin",
    state: "TX",
    postcode: "73301",
    country: "US",
    phonenumber: "+15555550101",
    status: "Active",
    groupid: "0",
    credit: "25.00",
    currency: "1",
    defaultgateway: "mock-gateway",
  },
] as const;

const FIXTURE_INVOICES = [
  {
    id: "2044",
    invoicenum: "INV-2044",
    userid: "502",
    date: "2026-09-01",
    duedate: "2026-09-15",
    datepaid: "0000-00-00 00:00:00",
    subtotal: "49.99",
    tax: "0.00",
    total: "49.99",
    balance: "49.99",
    status: "Unpaid",
    paymentmethod: "mock-gateway",
    notes: "",
    items: {
      item: [
        {
          id: "8801",
          type: "Hosting",
          relid: "601",
          description: "Shared Hosting - Starter (2026-09-01 to 2026-10-01)",
          amount: "49.99",
          taxed: "0",
        },
      ],
    },
  },
] as const;

const FIXTURE_TRANSACTIONS = [
  {
    id: "5001",
    invoiceid: "2044",
    userid: "502",
    gateway: "mock-gateway",
    date: "2026-09-01 00:00:05",
    description: "Invoice #2044 generated",
    amountin: "0.00",
    fees: "0.00",
    amountout: "0.00",
    transid: "",
  },
] as const;

const FIXTURE_QUOTES = [
  {
    id: "301",
    subject: "Managed onboarding package",
    stage: "Draft",
    userid: "501",
    dateCreated: "2026-09-20",
    lastModified: "2026-09-20",
    validUntil: "2026-10-20",
    total: "1200.00",
    currencyPrefix: "$",
    currencySuffix: "",
    lineItems: {
      lineItem: [
        {
          description: "Onboarding & migration (one-time)",
          quantity: "1",
          unitPrice: "1200.00",
          taxable: "0",
          discount: "0.00",
        },
      ],
    },
  },
] as const;

const FIXTURE_SERVICES = [
  {
    id: "601",
    userid: "502",
    orderid: "701",
    pid: "11",
    packagename: "Shared Hosting - Starter",
    domain: "client-site.example.test",
    domainstatus: "Active",
    regdate: "2026-01-15",
    nextduedate: "2026-10-01",
    billingcycle: "Monthly",
    amount: "9.99",
    status: "Active",
    username: "sh_client502",
    password: "[REDACTED-BY-FIXTURE]",
  },
] as const;

const FIXTURE_ADDONS = [
  {
    id: "9101",
    serviceid: "601",
    name: "Nightly Offsite Backup",
    status: "Active",
    recurring: "3.00",
    billingcycle: "Monthly",
    nextduedate: "2026-10-01",
  },
] as const;

const FIXTURE_PRODUCTS = [
  {
    pid: "11",
    gid: "1",
    type: "hostingaccount",
    name: "Shared Hosting - Starter",
    module: "mock-cpanel",
    paytype: "recurring",
    pricing: {
      USD: { prefix: "$", suffix: "USD", monthly: "9.99", annually: "99.99" },
    },
  },
] as const;

const FIXTURE_DOMAINS = [
  {
    id: "701",
    userid: "501",
    domainid: "701",
    domain: "riveraconsulting.example.test",
    registrar: "mock-registrar",
    regdate: "2025-06-01",
    expirydate: "2027-06-01",
    status: "Active",
    nextduedate: "2027-05-01",
    recurringamount: "14.99",
    dnsmanagement: "1",
    emailforwarding: "1",
    idprotection: "0",
    donotrenew: "0",
  },
] as const;

const FIXTURE_ORDERS = [
  {
    id: "701",
    ordernum: "ORD-701",
    userid: "501",
    date: "2025-06-01 10:00:00",
    status: "Active",
    paymentmethod: "mock-gateway",
    amount: "24.98",
    invoiceid: "2000",
  },
] as const;

// ---------------------------------------------------------------------------
// Fixture builders: one per WHMCS External API action implemented anywhere
// in the toolList (src/tools/*.ts). Actions are grouped by the domain that
// owns them per the architecture plan (system, tickets, clients, products,
// invoices, domains, orders) purely for readability here — the mock server
// itself is domain-agnostic and just dispatches on `action`.
// ---------------------------------------------------------------------------

// --- system ------------------------------------------------------------

const systemFixtures: FixtureMap = {
  // WhmcsDetails is the version-discovery action every server should call
  // at startup (see src/whmcs-client.ts's header note and
  // docs/version-compatibility.md). Reports the 9.0.6 target version from
  // the architecture plan's local-evidence findings.
  WhmcsDetails: () => ({
    version: "9.0.6",
    edition: "Extended License",
    company: "Mock WHMCS Instance (fixtures only, not a real deployment)",
    domain: "mock-whmcs.example.test",
    dbpassword: "[REDACTED-BY-FIXTURE]",
  }),
  GetStats: () => ({
    income_today: "0.00",
    income_thismonth: "1249.98",
    income_alltime: "48210.55",
    numorderstotal: "42",
    numinvoicesunpaid: "1",
    numticketsopen: "1",
    numemailsqueued: "0",
  }),
  GetActivityLog: (params) => {
    const limitnum = Number(params.get("limitnum") ?? "25");
    const rows = [
      {
        id: "1",
        date: "2026-09-27 15:10:44",
        description: "Ticket #TCK-1001 Reply Added by Sam Ortiz",
        user: "Sam Ortiz",
        userid: "1",
        ipaddr: "203.0.113.10",
      },
      {
        id: "2",
        date: "2026-09-25 11:00:00",
        description: "Invoice #2044 Marked as Unpaid",
        user: "System",
        userid: "0",
        ipaddr: "",
      },
    ].slice(0, Math.max(0, limitnum));
    return { activity: { entry: rows }, numreturned: String(rows.length), totalresults: "2" };
  },
  GetAdminDetails: () => ({
    userid: "1",
    firstname: "Sam",
    lastname: "Ortiz",
    email: "sam.ortiz@example.test",
    // Mirrors the real API's per-action permission array; the redaction
    // layer does NOT strip this (it is authorization metadata, not a
    // secret), but it is still entirely synthetic here.
    permissions: { permission: ["Support", "Clients", "Billing"] },
  }),
  GetToDoItems: () => ({
    todoitems: {
      todoitem: [
        {
          id: "1",
          date: "2026-09-29",
          description: "Review overdue invoice INV-2044",
          status: "Not Started",
        },
      ],
    },
  }),
  GetEmailTemplates: (params) => {
    const type = params.get("type") ?? "general";
    return {
      emailtemplates: {
        template: [
          {
            id: "1",
            name: "Mock Welcome Email",
            subject: "Welcome to Mock WHMCS",
            type,
            language: params.get("language") ?? "english",
            custom: "0",
          },
        ],
      },
    };
  },
  SendEmail: (params) => ({
    // WHMCS's SendEmail has no distinctive success payload beyond `result`;
    // echo back what would identify the send for test assertions.
    sent: true,
    messagename: params.get("messagename") ?? undefined,
    id: params.get("id") ?? undefined,
  }),
  GetPaymentMethods: () => ({
    paymentmethods: {
      paymentmethod: [
        { module: "mock-gateway", displayname: "Mock Gateway (Credit Card)" },
        { module: "banktransfer", displayname: "Bank Transfer" },
      ],
    },
  }),
  GetCurrencies: () => ({
    currencies: {
      currency: [{ id: "1", code: "USD", prefix: "$", suffix: "USD", rate: "1.00", default: "1" }],
    },
  }),
  LogActivity: (params) => ({
    logged: true,
    description: params.get("description") ?? undefined,
    clientid: params.get("clientid") ?? undefined,
  }),
};

// --- tickets -------------------------------------------------------------

function findTicket(params: URLSearchParams) {
  const ticketid = params.get("ticketid");
  const ticketnum = params.get("ticketnum");
  return (
    FIXTURE_TICKETS.find((t) => t.id === ticketid) ??
    FIXTURE_TICKETS.find((t) => t.tid === ticketnum) ??
    FIXTURE_TICKETS[0]
  );
}

const ticketFixtures: FixtureMap = {
  GetTickets: (params) => {
    const status = params.get("status");
    const rows = FIXTURE_TICKETS.filter((t) => !status || status === "All Active Tickets" || t.status === status).map(
      ({ replies: _replies, ...rest }) => rest,
    );
    return { tickets: { ticket: rows }, numreturned: String(rows.length), totalresults: String(FIXTURE_TICKETS.length) };
  },
  GetTicket: (params) => ({ ...findTicket(params) }),
  GetTicketNotes: () => ({
    notes: { note: [{ id: "1", message: "Escalated to on-call engineer.", admin: "Sam Ortiz", date: "2026-09-27 14:05:00" }] },
  }),
  GetTicketAttachment: () => ({
    data: { filename: "mock-screenshot.png", data: Buffer.from("not-a-real-image").toString("base64") },
  }),
  GetTicketCounts: () => ({
    open: "1",
    answered: "1",
    customerreply: "0",
    closed: "0",
    total: "2",
  }),
  GetSupportDepartments: () => ({
    departments: {
      department: [
        { id: "1", name: "Technical Support" },
        { id: "2", name: "Billing" },
      ],
    },
  }),
  GetSupportStatuses: () => ({
    statuses: { status: ["Open", "Answered", "Customer-Reply", "On Hold", "Closed", "In Progress"] },
  }),
  GetTicketPredefinedReplies: () => ({
    predefinedreplies: {
      predefinedreply: [{ id: "1", category: "General", subject: "Thanks", message: "Thanks for reaching out!" }],
    },
  }),
  OpenTicket: (params) => ({
    ticketid: "1003",
    tid: "TCK-1003",
    subject: params.get("subject") ?? undefined,
    deptid: params.get("deptid") ?? undefined,
  }),
  AddTicketReply: (params) => ({ replyid: "9003", ticketid: params.get("ticketid") ?? undefined }),
  AddTicketNote: (params) => ({ noteid: "2", ticketid: params.get("ticketid") ?? undefined }),
  UpdateTicket: (params) => ({ ticketid: params.get("ticketid") ?? undefined, updated: true }),
  UpdateTicketReply: (params) => ({ replyid: params.get("replyid") ?? undefined, updated: true }),
  MergeTicket: (params) => ({
    ticketid: params.get("ticketid") ?? undefined,
    merged: (params.get("mergeticketids") ?? "").split(",").filter(Boolean),
  }),
  DeleteTicket: (params) => ({ ticketid: params.get("ticketid") ?? undefined, deleted: true }),
};

// --- clients ---------------------------------------------------------------

function findClient(params: URLSearchParams) {
  const clientid = params.get("clientid");
  const email = params.get("email") ?? params.get("clientemail");
  return (
    FIXTURE_CLIENTS.find((c) => c.id === clientid) ??
    FIXTURE_CLIENTS.find((c) => c.email === email) ??
    FIXTURE_CLIENTS[0]
  );
}

const clientFixtures: FixtureMap = {
  GetClients: (params) => {
    const search = (params.get("search") ?? "").toLowerCase();
    const rows = FIXTURE_CLIENTS.filter(
      (c) => !search || `${c.firstname} ${c.lastname} ${c.email}`.toLowerCase().includes(search),
    );
    return { clients: { client: rows }, numreturned: String(rows.length), totalresults: String(FIXTURE_CLIENTS.length) };
  },
  GetClientsDetails: (params) => ({ client: findClient(params) }),
  AddClient: (params) => ({ clientid: "503", firstname: params.get("firstname") ?? undefined }),
  UpdateClient: (params) => ({ clientid: params.get("clientid") ?? findClient(params).id, updated: true }),
  CloseClient: (params) => ({ clientid: params.get("clientid") ?? undefined, closed: true }),
  GetContacts: () => ({
    contacts: {
      contact: [
        {
          id: "1",
          userid: "501",
          firstname: "Alex",
          lastname: "Kim",
          email: "alex.kim@example.test",
          permissions: "General,Support",
        },
      ],
    },
  }),
  AddContact: (params) => ({ contactid: "2", clientid: params.get("clientid") ?? undefined }),
  UpdateContact: (params) => ({ contactid: params.get("contactid") ?? undefined, updated: true }),
  GetEmails: () => ({
    emails: {
      email: [
        {
          id: "1",
          date: "2026-09-01 00:00:05",
          subject: "Invoice #2044 Generated",
          to: "priya.natarajan@example.test",
        },
      ],
    },
  }),
  GetClientGroups: () => ({ groups: { group: [{ id: "0", name: "Default" }] } }),
  GetClientsProducts: () => ({ products: { product: FIXTURE_SERVICES.map((s) => ({ ...s })) } }),
  GetClientsAddons: () => ({ addons: { addon: FIXTURE_ADDONS.map((a) => ({ ...a })) } }),
};

// --- products / services -----------------------------------------------

const productFixtures: FixtureMap = {
  GetProducts: () => ({ products: { product: FIXTURE_PRODUCTS.map((p) => ({ ...p })) } }),
  GetPromotions: () => ({
    promotions: {
      promotion: [{ code: "MOCK10", type: "percentage", value: "10", cycles: "Monthly,Annually" }],
    },
  }),
  UpdateClientProduct: (params) => ({ serviceid: params.get("serviceid") ?? undefined, updated: true }),
  UpdateClientAddon: (params) => ({ id: params.get("id") ?? undefined, updated: true }),
  UpgradeProduct: (params) => ({
    orderid: "702",
    serviceid: params.get("serviceid") ?? undefined,
    // calconly=true is the documented "preview, no mutation" path this
    // tool's plan entry uses for its confirmation preview.
    calconly: params.get("calconly") === "true",
    amount: "19.99",
    recurring: "19.99",
  }),
  ModuleCreate: (params) => ({ serviceid: params.get("serviceid") ?? undefined, moduleresponse: "Success" }),
  ModuleSuspend: (params) => ({ serviceid: params.get("serviceid") ?? undefined, moduleresponse: "Success" }),
  ModuleUnsuspend: (params) => ({ serviceid: params.get("serviceid") ?? undefined, moduleresponse: "Success" }),
  ModuleTerminate: (params) => ({ serviceid: params.get("serviceid") ?? undefined, moduleresponse: "Success" }),
  ModuleChangePackage: (params) => ({ serviceid: params.get("serviceid") ?? undefined, moduleresponse: "Success" }),
};

// --- invoices / quotes -------------------------------------------------

function findInvoice(params: URLSearchParams) {
  return FIXTURE_INVOICES.find((i) => i.id === params.get("invoiceid")) ?? FIXTURE_INVOICES[0];
}

const invoiceFixtures: FixtureMap = {
  GetInvoices: (params) => {
    const status = params.get("status");
    const rows = FIXTURE_INVOICES.filter((i) => !status || i.status === status).map(({ items: _items, ...rest }) => rest);
    return { invoices: { invoice: rows }, numreturned: String(rows.length), totalresults: String(FIXTURE_INVOICES.length) };
  },
  GetInvoice: (params) => ({
    ...findInvoice(params),
    transactions: { transaction: FIXTURE_TRANSACTIONS.map((t) => ({ ...t })) },
  }),
  // Billing-tier tools (off unless WHMCS_MCP_MODE=full, per the operator's
  // "invoices are operator-manual" policy note in the plan). The mock still
  // fixtures these so the confirm-token/dryRun flow can be tested in
  // isolation from the real gating, which is enforced in
  // src/safety/policy.ts, not here.
  CreateInvoice: () => ({ invoiceid: "2045" }),
  UpdateInvoice: (params) => ({ invoiceid: params.get("invoiceid") ?? undefined, updated: true }),
  AddInvoicePayment: (params) => ({ invoiceid: params.get("invoiceid") ?? undefined, transid: params.get("transid") ?? undefined }),
  ApplyCredit: (params) => ({ invoiceid: params.get("invoiceid") ?? undefined, applied: params.get("amount") ?? "full" }),
  CapturePayment: (params) => ({ invoiceid: params.get("invoiceid") ?? undefined, captured: true }),
  AddCredit: (params) => ({ clientid: params.get("clientid") ?? undefined, creditid: "301" }),
  GetCredits: () => ({ credits: { credit: [{ id: "301", date: "2026-09-10", description: "Mock goodwill credit", amount: "25.00" }] } }),
  GetTransactions: () => ({ transactions: { transaction: FIXTURE_TRANSACTIONS.map((t) => ({ ...t })) } }),
  AddBillableItem: () => ({ itemid: "8802" }),
  GetPayMethods: () => ({
    paymethods: {
      paymethod: [
        { id: "1", type: "CreditCard", description: "Visa ending 4242" },
      ],
    },
  }),
  GetQuotes: () => ({ quotes: { quote: FIXTURE_QUOTES.map((q) => ({ ...q, lineItems: undefined })).map(({ lineItems: _l, ...rest }) => rest) } }),
  CreateQuote: () => ({ quoteid: "302" }),
  UpdateQuote: (params) => ({ quoteid: params.get("quoteid") ?? undefined, updated: true }),
  SendQuote: (params) => ({ quoteid: params.get("quoteid") ?? undefined, sent: true }),
};

// --- domains -------------------------------------------------------------

const domainFixtures: FixtureMap = {
  GetClientsDomains: () => ({
    domains: { domain: FIXTURE_DOMAINS.map((d) => ({ ...d })) },
    numreturned: String(FIXTURE_DOMAINS.length),
    totalresults: String(FIXTURE_DOMAINS.length),
  }),
  DomainWhois: (params) => ({
    domain: params.get("domain") ?? undefined,
    available: true,
    premium: false,
  }),
  DomainGetNameservers: () => ({ ns1: "ns1.mock-registrar.example.test", ns2: "ns2.mock-registrar.example.test" }),
  DomainUpdateNameservers: (params) => ({ domainid: params.get("domainid") ?? undefined, updated: true }),
  DomainGetLockingStatus: () => ({ locked: true }),
  DomainUpdateLockingStatus: (params) => ({ domainid: params.get("domainid") ?? undefined, locked: params.get("lockstatus") === "true" }),
  DomainGetWhoisInfo: () => ({
    Registrant: {
      "First Name": "Jordan",
      "Last Name": "Rivera",
      Email: "jordan.rivera@example.test",
      "Organization Name": "Rivera Consulting LLC",
    },
  }),
  UpdateClientDomain: (params) => ({ domainid: params.get("domainid") ?? undefined, updated: true }),
  DomainRenew: (params) => ({ domainid: params.get("domainid") ?? undefined, invoiceid: "2046" }),
  DomainRegister: (params) => ({ domainid: params.get("domainid") ?? undefined, invoiceid: "2047" }),
  DomainTransfer: (params) => ({ domainid: params.get("domainid") ?? undefined, invoiceid: "2048" }),
  GetTLDPricing: () => ({
    pricing: {
      test: {
        register: { 1: "12.99" },
        renew: { 1: "14.99" },
        transfer: { 1: "12.99" },
      },
    },
  }),
};

// --- orders ----------------------------------------------------------------

const orderFixtures: FixtureMap = {
  GetOrders: () => ({
    orders: { order: FIXTURE_ORDERS.map((o) => ({ ...o })) },
    numreturned: String(FIXTURE_ORDERS.length),
    totalresults: String(FIXTURE_ORDERS.length),
  }),
  GetOrderStatuses: () => ({ statuses: { status: ["Pending", "Active", "Fraud", "Cancelled"] } }),
  AddOrder: () => ({ orderid: "703", invoiceid: "2049" }),
  AcceptOrder: (params) => ({ orderid: params.get("orderid") ?? undefined, accepted: true }),
  PendingOrder: (params) => ({ orderid: params.get("orderid") ?? undefined, status: "Pending" }),
  CancelOrder: (params) => ({ orderid: params.get("orderid") ?? undefined, status: "Cancelled" }),
  FraudOrder: (params) => ({ orderid: params.get("orderid") ?? undefined, status: "Fraud" }),
  DeleteOrder: (params) => ({ orderid: params.get("orderid") ?? undefined, deleted: true }),
};

/**
 * The complete built-in fixture table, merged from every domain group
 * above. Keyed by the exact WHMCS External API `action` name (case
 * sensitive, matching developers.whmcs.com/api-reference).
 */
export const FIXTURES: Readonly<FixtureMap> = Object.freeze({
  ...systemFixtures,
  ...ticketFixtures,
  ...clientFixtures,
  ...productFixtures,
  ...invoiceFixtures,
  ...domainFixtures,
  ...orderFixtures,
});

// ---------------------------------------------------------------------------
// Server implementation
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB — generous for form-encoded test payloads.

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`mock-whmcs-server: request body exceeded ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function jsonResponse(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

function redactParamsForRecord(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    out[key] = key === "secret" ? "[REDACTED]" : value;
  }
  return out;
}

/**
 * Verifies that the request's `identifier`/`secret` (and `accesskey`, if
 * the server is configured to require one) match the expected credentials.
 * Exported standalone so tests can assert on the auth-check logic itself
 * without spinning up a full HTTP round trip.
 */
export function checkAuthParams(
  params: URLSearchParams,
  expected: MockWhmcsCredentials,
): { ok: true } | { ok: false; message: string } {
  const identifier = params.get("identifier");
  const secret = params.get("secret");
  if (!identifier || !secret) {
    return { ok: false, message: "Missing API identifier/secret" };
  }
  if (identifier !== expected.identifier || secret !== expected.secret) {
    // Matches WHMCS's actual (non-specific, to avoid credential-guessing
    // oracle behavior) error message for this failure mode.
    return { ok: false, message: "Invalid IP" }; // WHMCS also uses this message when IP-restricted; kept generic on purpose.
  }
  if (expected.accessKey) {
    const accesskey = params.get("accesskey");
    if (accesskey !== expected.accessKey) {
      return { ok: false, message: "Invalid Access Key" };
    }
  }
  return { ok: true };
}

/**
 * Starts the mock WHMCS External API server. Resolves once it is actually
 * listening (Node's `listening` event has fired), so callers can
 * immediately use `.url` without a race.
 *
 * Usage in a vitest suite:
 * ```ts
 * const mock = await startMockWhmcsServer();
 * const client = new WhmcsClient({
 *   apiUrl: mock.url,
 *   identifier: DEFAULT_MOCK_CREDENTIALS.identifier,
 *   secret: DEFAULT_MOCK_CREDENTIALS.secret,
 *   allowInsecure: true, // mock server is plain http://
 * });
 * // ... exercise client.call("WhmcsDetails") ...
 * await mock.close();
 * ```
 *
 * Usage from scripts/capture-screenshots.ts: start this server, then spawn
 * the real MCP server (src/index.ts) with WHMCS_API_URL/IDENTIFIER/SECRET
 * pointed at `mock.url` / the credentials used here, and drive it through
 * @modelcontextprotocol/inspector — never against a real WHMCS instance.
 */
export async function startMockWhmcsServer(
  options: MockWhmcsServerOptions = {},
): Promise<MockWhmcsServer> {
  const credentials = options.credentials ?? DEFAULT_MOCK_CREDENTIALS;
  const host = options.host ?? "127.0.0.1";
  const latencyMs = options.latencyMs ?? 0;
  // `Partial<FixtureMap>` overrides can carry explicit `undefined` values
  // under `noUncheckedIndexedAccess`; the lookup below already treats a
  // missing/undefined entry as "no fixture registered", so the merged map's
  // value type stays `FixtureFn | undefined` rather than forcing a cast.
  const fixtures: Record<string, FixtureFn | undefined> = {
    ...FIXTURES,
    ...(options.fixtureOverrides ?? {}),
  };
  const calls: RecordedCall[] = [];
  const rawRequests: RawRequestRecord[] = [];
  const responseQueue: QueuedResponse[] = [];

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  /** Sends a fully-scripted `QueuedResponse` verbatim, bypassing auth/fixtures. */
  function sendQueuedResponse(res: ServerResponse, queued: QueuedResponse): void {
    if (queued.delayMs && queued.delayMs > 0) {
      setTimeout(() => sendQueuedResponseNow(res, queued), queued.delayMs);
      return;
    }
    sendQueuedResponseNow(res, queued);
  }

  function sendQueuedResponseNow(res: ServerResponse, queued: QueuedResponse): void {
    const status = queued.status ?? 200;
    if (queued.body !== undefined) {
      jsonResponse(res, status, queued.body);
      return;
    }
    const raw = queued.rawBody ?? "";
    const contentType = queued.contentType ?? "text/plain; charset=utf-8";
    res.writeHead(status, {
      "Content-Type": contentType,
      "Content-Length": Buffer.byteLength(raw).toString(),
    });
    res.end(raw);
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only the External API endpoint is served. Anything else 404s, which
    // also lets a misconfigured WHMCS_API_URL (missing base path handling)
    // fail loudly in tests instead of silently matching.
    if (req.method !== "POST" || !(req.url ?? "").endsWith("/includes/api.php")) {
      jsonResponse(res, 404, { result: "error", message: "mock-whmcs-server: not found" });
      return;
    }

    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch (err) {
      jsonResponse(res, 413, { result: "error", message: (err as Error).message });
      return;
    }

    const params = new URLSearchParams(bodyText);
    const action = params.get("action");

    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }

    // Raw record first, before any short-circuiting below, so
    // `lastRequest()`/`requestCount()` see every inbound request —
    // including ones a queued response answers without touching fixtures.
    rawRequests.push({
      method: req.method ?? "POST",
      url: req.url ?? "",
      headers: { ...req.headers },
      rawBody: bodyText,
      receivedAt: Date.now(),
    });
    calls.push({ action: action ?? "(missing action)", params: redactParamsForRecord(params), receivedAt: Date.now() });

    // A queued response fully scripts this call's answer (used by contract
    // tests to simulate exact HTTP-level conditions — a bare 500, a 429, a
    // non-JSON body, a "fail N times then succeed" retry sequence). It
    // deliberately skips auth checking and fixture lookup: the test is
    // asserting on the client's handling of the response, not on this
    // server's normal behavior.
    const queued = responseQueue.shift();
    if (queued) {
      sendQueuedResponse(res, queued);
      return;
    }

    const auth = checkAuthParams(params, credentials);
    if (!auth.ok) {
      // Real WHMCS responds 200 with an error envelope for auth failures,
      // not an HTTP 401/403 — src/whmcs-client.ts's WhmcsApiError mapping
      // relies on reading `result === "error"` from a 200 body for this
      // case specifically (it only treats non-2xx as an HTTP-level error).
      jsonResponse(res, 200, { result: "error", message: auth.message });
      return;
    }

    if (!action) {
      jsonResponse(res, 200, { result: "error", message: "Invalid or Missing action" });
      return;
    }

    // Escape hatch for whmcs_raw_call and ad-hoc test actions: a magic
    // param lets a test force a specific error/status without needing a
    // bespoke fixture. Never triggered by production tool serializers.
    const forcedError = params.get("__mockForceError");
    if (forcedError) {
      const forcedStatus = Number(params.get("__mockForceHttpStatus") ?? "200");
      jsonResponse(res, forcedStatus, { result: "error", message: forcedError });
      return;
    }

    const fixture = fixtures[action];
    if (!fixture) {
      jsonResponse(res, 200, {
        result: "error",
        message: `mock-whmcs-server: no fixture registered for action "${action}". ` +
          `Add one to test/mock-whmcs-server.ts's FIXTURES map or pass fixtureOverrides.`,
      });
      return;
    }

    try {
      const data = fixture(params);
      jsonResponse(res, 200, { result: "success", ...data });
    } catch (err) {
      jsonResponse(res, 200, {
        result: "error",
        message: `mock-whmcs-server: fixture for "${action}" threw: ${(err as Error).message}`,
      });
    }
  }

  server.listen(options.port ?? 0, host);
  await once(server, "listening");

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port ?? 0;

  function reset(): void {
    calls.length = 0;
    rawRequests.length = 0;
    responseQueue.length = 0;
  }

  return {
    server,
    port,
    host,
    url: `http://${host}:${port}`,
    calls,
    callLog: calls,
    reset,
    resetCallLog: reset,
    queueResponse(response: QueuedResponse): void {
      responseQueue.push(response);
    },
    lastRequest(): RawRequestRecord | undefined {
      return rawRequests.at(-1);
    },
    requestCount(): number {
      return rawRequests.length;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * Alias of `startMockWhmcsServer`. Some test files (e.g. `client.test.ts`,
 * which drives `src/whmcs-client.ts` at the raw-transport level via
 * `queueResponse`/`lastRequest`/`requestCount`) import it under this name;
 * both names start the exact same server with the exact same superset API.
 */
export const createMockWhmcsServer = startMockWhmcsServer;

/**
 * Convenience env-var bundle for wiring a real WhmcsClient / the full MCP
 * server binary at a running mock instance, e.g. from
 * scripts/capture-screenshots.ts when spawning `dist/index.js` as a
 * subprocess.
 */
export function mockWhmcsEnv(
  mock: Pick<MockWhmcsServer, "url">,
  credentials: MockWhmcsCredentials = DEFAULT_MOCK_CREDENTIALS,
): Record<string, string> {
  const env: Record<string, string> = {
    WHMCS_API_URL: mock.url,
    WHMCS_API_IDENTIFIER: credentials.identifier,
    WHMCS_API_SECRET: credentials.secret,
    // The mock server is plain http:// on localhost; only the mock/dev path
    // should ever set this. src/config.ts refuses http:// otherwise.
    WHMCS_MCP_ALLOW_INSECURE: "true",
  };
  if (credentials.accessKey) {
    env.WHMCS_API_ACCESS_KEY = credentials.accessKey;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Standalone CLI entry point
//
// `tsx test/mock-whmcs-server.ts` (or `node --import tsx ...`) runs this
// server on its own for manual poking with curl, or for
// scripts/capture-screenshots.ts to launch as a subprocess rather than
// in-process. Port is configurable via MOCK_WHMCS_PORT to avoid colliding
// with any other local service (this project reserves several ports for
// other tools — see the repo's CLAUDE.md — so the default here is
// deliberately an unused, unreserved one).
// ---------------------------------------------------------------------------
// (Reserved/in-use ports this repo documents elsewhere: 4610/4611 Vantage
// Harness, 3032 CCEM APM (deprecated), 8330 strategic-report E2E,
// 4178/4188 jamf-proposal bridge/dashboard, 9223 managed Chrome CDP.)

const isDirectRun = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const port = Number(process.env.MOCK_WHMCS_PORT ?? "8940");
  startMockWhmcsServer({ port })
    .then((mock) => {
      // eslint-disable-next-line no-console -- CLI-only diagnostic output.
      console.log(`mock-whmcs-server: listening at ${mock.url}/includes/api.php`);
      // eslint-disable-next-line no-console
      console.log(
        `mock-whmcs-server: credentials identifier="${DEFAULT_MOCK_CREDENTIALS.identifier}" secret="${DEFAULT_MOCK_CREDENTIALS.secret}"`,
      );
      const shutdown = (): void => {
        void mock.close().then(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("mock-whmcs-server: failed to start", err);
      process.exitCode = 1;
    });
}
