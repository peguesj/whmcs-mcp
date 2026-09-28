/**
 * test/tools.test.ts
 *
 * Contract tests for every MCP tool exposed by @peguesj/whmcs-mcp.
 *
 * Scope (per the architecture plan's file layout entry for this path):
 *   - schema -> WHMCS param serialization for every tool in the toolList
 *   - result shape (each tool returns MCP content + structuredContent that
 *     matches the normalized, redacted shape the client produces)
 *   - mode filtering (readonly | write | full) and per-domain enable/disable
 *     via WHMCS_MCP_ENABLE_DOMAINS
 *
 * These tests exercise the tool registry (src/tools/registry.ts + the
 * per-domain src/tools/*.ts modules) against the in-process mock WHMCS
 * server (test/mock-whmcs-server.ts), never a real WHMCS instance.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { startMockWhmcsServer, type MockWhmcsServer } from "./mock-whmcs-server.js";
import { createWhmcsClient, type WhmcsClient } from "../src/whmcs-client.js";
import { buildToolRegistry, type RegisteredTool, type ToolTier } from "../src/tools/registry.js";
import type { WhmcsMcpMode } from "../src/config.js";

/* -------------------------------------------------------------------------
 * Fixtures: mirrors toolList from the architecture plan.
 *
 * Each entry: [toolName, domain, whmcsAction, tier]. This table is the
 * single source of truth this test file walks to build its assertions, so
 * adding a tool to src/tools/<domain>.ts without adding it here fails the
 * "every tool is covered" meta-test at the bottom of the file.
 * ---------------------------------------------------------------------- */

type ToolFixture = {
  readonly name: string;
  readonly domain: string;
  readonly action: string;
  readonly tier: ToolTier;
  /** Minimal valid input that should pass the zod schema and round-trip to WHMCS. */
  readonly sampleInput: Record<string, unknown>;
  /** True if this tool requires a confirmToken (billing/destructive tier tools always do). */
  readonly requiresConfirm?: boolean;
};

const TOOL_FIXTURES: readonly ToolFixture[] = [
  // --- system ---
  { name: "system_get_details", domain: "system", action: "GetDetails", tier: "read", sampleInput: {} },
  { name: "system_get_stats", domain: "system", action: "GetStats", tier: "read", sampleInput: {} },
  {
    name: "system_get_activity_log",
    domain: "system",
    action: "GetActivityLog",
    tier: "read",
    sampleInput: { limitnum: 10 },
  },
  { name: "system_get_admin_details", domain: "system", action: "GetAdminDetails", tier: "read", sampleInput: {} },
  { name: "system_get_todo_items", domain: "system", action: "GetToDoItems", tier: "read", sampleInput: {} },
  {
    name: "system_get_email_templates",
    domain: "system",
    action: "GetEmailTemplates",
    tier: "read",
    sampleInput: { type: "general" },
  },
  {
    name: "system_send_email",
    domain: "system",
    action: "SendEmail",
    tier: "write",
    sampleInput: { messagename: "Test Email", id: 1 },
  },
  { name: "system_get_payment_methods", domain: "system", action: "GetPaymentMethods", tier: "read", sampleInput: {} },
  { name: "system_get_currencies", domain: "system", action: "GetCurrencies", tier: "read", sampleInput: {} },
  {
    name: "system_log_activity",
    domain: "system",
    action: "LogActivity",
    tier: "write",
    sampleInput: { description: "MCP contract test" },
  },
  {
    name: "whmcs_raw_call",
    domain: "system",
    action: "<dynamic>",
    tier: "write",
    sampleInput: { action: "GetDetails", params: {} },
    requiresConfirm: true,
  },

  // --- tickets ---
  { name: "tickets_list", domain: "tickets", action: "GetTickets", tier: "read", sampleInput: { limitnum: 25 } },
  { name: "tickets_get", domain: "tickets", action: "GetTicket", tier: "read", sampleInput: { ticketid: 1 } },
  {
    name: "tickets_create",
    domain: "tickets",
    action: "OpenTicket",
    tier: "write",
    sampleInput: { deptid: 1, subject: "Test", message: "Test message", clientid: 1 },
  },
  {
    name: "tickets_reply",
    domain: "tickets",
    action: "AddTicketReply",
    tier: "write",
    sampleInput: { ticketid: 1, message: "Reply" },
  },
  {
    name: "tickets_add_note",
    domain: "tickets",
    action: "AddTicketNote",
    tier: "write",
    sampleInput: { ticketid: 1, message: "Note" },
  },
  { name: "tickets_get_notes", domain: "tickets", action: "GetTicketNotes", tier: "read", sampleInput: { ticketid: 1 } },
  {
    name: "tickets_update",
    domain: "tickets",
    action: "UpdateTicket",
    tier: "write",
    sampleInput: { ticketid: 1, status: "Closed" },
  },
  {
    name: "tickets_update_reply",
    domain: "tickets",
    action: "UpdateTicketReply",
    tier: "write",
    sampleInput: { replyid: 1, message: "Edited" },
  },
  {
    name: "tickets_merge",
    domain: "tickets",
    action: "MergeTicket",
    tier: "destructive",
    sampleInput: { ticketid: 1, mergeticketids: "2,3" },
    requiresConfirm: true,
  },
  {
    name: "tickets_delete",
    domain: "tickets",
    action: "DeleteTicket",
    tier: "destructive",
    sampleInput: { ticketid: 1 },
    requiresConfirm: true,
  },
  {
    name: "tickets_get_attachment",
    domain: "tickets",
    action: "GetTicketAttachment",
    tier: "read",
    sampleInput: { relatedid: 1, type: "ticket", index: 0 },
  },
  { name: "tickets_get_counts", domain: "tickets", action: "GetTicketCounts", tier: "read", sampleInput: {} },
  { name: "tickets_get_departments", domain: "tickets", action: "GetSupportDepartments", tier: "read", sampleInput: {} },
  { name: "tickets_get_statuses", domain: "tickets", action: "GetSupportStatuses", tier: "read", sampleInput: {} },
  {
    name: "tickets_get_predefined_replies",
    domain: "tickets",
    action: "GetTicketPredefinedReplies",
    tier: "read",
    sampleInput: {},
  },

  // --- clients ---
  { name: "clients_list", domain: "clients", action: "GetClients", tier: "read", sampleInput: { limitnum: 25 } },
  { name: "clients_get", domain: "clients", action: "GetClientsDetails", tier: "read", sampleInput: { clientid: 1 } },
  {
    name: "clients_create",
    domain: "clients",
    action: "AddClient",
    tier: "write",
    sampleInput: {
      firstname: "Test",
      lastname: "Client",
      email: "test@example.com",
      address1: "1 Test St",
      city: "Testville",
      state: "GA",
      postcode: "30303",
      country: "US",
      phonenumber: "5555555555",
    },
  },
  {
    name: "clients_update",
    domain: "clients",
    action: "UpdateClient",
    tier: "write",
    sampleInput: { clientid: 1, notes: "Updated by contract test" },
  },
  {
    name: "clients_close",
    domain: "clients",
    action: "CloseClient",
    tier: "destructive",
    sampleInput: { clientid: 1 },
    requiresConfirm: true,
  },
  { name: "clients_get_contacts", domain: "clients", action: "GetContacts", tier: "read", sampleInput: { userid: 1 } },
  {
    name: "clients_add_contact",
    domain: "clients",
    action: "AddContact",
    tier: "write",
    sampleInput: { clientid: 1, firstname: "Con", lastname: "Tact", email: "contact@example.com" },
  },
  {
    name: "clients_update_contact",
    domain: "clients",
    action: "UpdateContact",
    tier: "write",
    sampleInput: { contactid: 1, firstname: "Con" },
  },
  { name: "clients_get_emails", domain: "clients", action: "GetEmails", tier: "read", sampleInput: { clientid: 1 } },
  { name: "clients_get_groups", domain: "clients", action: "GetClientGroups", tier: "read", sampleInput: {} },

  // --- products (clients_get_services/addons live in this domain per the plan) ---
  {
    name: "clients_get_services",
    domain: "products",
    action: "GetClientsProducts",
    tier: "read",
    sampleInput: { clientid: 1 },
  },
  {
    name: "clients_get_addons",
    domain: "products",
    action: "GetClientsAddons",
    tier: "read",
    sampleInput: { clientid: 1 },
  },
  { name: "products_list", domain: "products", action: "GetProducts", tier: "read", sampleInput: {} },
  { name: "products_get_promotions", domain: "products", action: "GetPromotions", tier: "read", sampleInput: {} },
  {
    name: "services_update",
    domain: "products",
    action: "UpdateClientProduct",
    tier: "write",
    sampleInput: { serviceid: 1, notes: "Contract test" },
  },
  {
    name: "services_update_addon",
    domain: "products",
    action: "UpdateClientAddon",
    tier: "write",
    sampleInput: { id: 1, status: "Active" },
  },
  {
    name: "services_upgrade",
    domain: "products",
    action: "UpgradeProduct",
    tier: "billing",
    sampleInput: { serviceid: 1, type: "product", newproductid: 2, paymentmethod: "mock", calconly: true },
    requiresConfirm: true,
  },
  {
    name: "services_module_create",
    domain: "products",
    action: "ModuleCreate",
    tier: "write",
    sampleInput: { serviceid: 1 },
    requiresConfirm: true,
  },
  {
    name: "services_module_suspend",
    domain: "products",
    action: "ModuleSuspend",
    tier: "write",
    sampleInput: { serviceid: 1, suspendreason: "Contract test" },
    requiresConfirm: true,
  },
  {
    name: "services_module_unsuspend",
    domain: "products",
    action: "ModuleUnsuspend",
    tier: "write",
    sampleInput: { serviceid: 1 },
    requiresConfirm: true,
  },
  {
    name: "services_module_terminate",
    domain: "products",
    action: "ModuleTerminate",
    tier: "destructive",
    sampleInput: { serviceid: 1 },
    requiresConfirm: true,
  },
  {
    name: "services_module_change_package",
    domain: "products",
    action: "ModuleChangePackage",
    tier: "write",
    sampleInput: { serviceid: 1 },
    requiresConfirm: true,
  },

  // --- invoices (billing_* and quotes_*) ---
  { name: "billing_list_invoices", domain: "invoices", action: "GetInvoices", tier: "read", sampleInput: {} },
  { name: "billing_get_invoice", domain: "invoices", action: "GetInvoice", tier: "read", sampleInput: { invoiceid: 1 } },
  {
    name: "billing_create_invoice",
    domain: "invoices",
    action: "CreateInvoice",
    tier: "billing",
    sampleInput: { userid: 1, status: "Draft", items: [{ description: "Test item", amount: "10.00" }] },
    requiresConfirm: true,
  },
  {
    name: "billing_update_invoice",
    domain: "invoices",
    action: "UpdateInvoice",
    tier: "billing",
    sampleInput: { invoiceid: 1, notes: "Contract test" },
    requiresConfirm: true,
  },
  {
    name: "billing_add_payment",
    domain: "invoices",
    action: "AddInvoicePayment",
    tier: "billing",
    sampleInput: { invoiceid: 1, transid: "TX-1", gateway: "mock" },
    requiresConfirm: true,
  },
  {
    name: "billing_apply_credit",
    domain: "invoices",
    action: "ApplyCredit",
    tier: "billing",
    sampleInput: { invoiceid: 1, amount: "5.00" },
    requiresConfirm: true,
  },
  {
    name: "billing_capture_payment",
    domain: "invoices",
    action: "CapturePayment",
    tier: "billing",
    sampleInput: { invoiceid: 1 },
    requiresConfirm: true,
  },
  {
    name: "billing_add_credit",
    domain: "invoices",
    action: "AddCredit",
    tier: "billing",
    sampleInput: { clientid: 1, description: "Contract test credit", amount: "1.00" },
    requiresConfirm: true,
  },
  { name: "billing_get_credits", domain: "invoices", action: "GetCredits", tier: "read", sampleInput: { clientid: 1 } },
  { name: "billing_get_transactions", domain: "invoices", action: "GetTransactions", tier: "read", sampleInput: {} },
  {
    name: "billing_add_billable_item",
    domain: "invoices",
    action: "AddBillableItem",
    tier: "billing",
    sampleInput: { clientid: 1, description: "Contract test", amount: "1.00" },
    requiresConfirm: true,
  },
  {
    name: "billing_get_pay_methods",
    domain: "invoices",
    action: "GetPayMethods",
    tier: "read",
    sampleInput: { clientid: 1 },
  },
  { name: "quotes_list", domain: "invoices", action: "GetQuotes", tier: "read", sampleInput: {} },
  {
    name: "quotes_create",
    domain: "invoices",
    action: "CreateQuote",
    tier: "billing",
    sampleInput: {
      subject: "Contract test quote",
      stage: "Draft",
      validuntil: "2026-12-31",
      userid: 1,
      lineitems: [{ desc: "Item", qty: 1, up: "10.00" }],
    },
    requiresConfirm: true,
  },
  {
    name: "quotes_update",
    domain: "invoices",
    action: "UpdateQuote",
    tier: "billing",
    sampleInput: { quoteid: 1, subject: "Updated" },
    requiresConfirm: true,
  },
  {
    name: "quotes_send",
    domain: "invoices",
    action: "SendQuote",
    tier: "write",
    sampleInput: { quoteid: 1 },
    requiresConfirm: true,
  },

  // --- domains ---
  { name: "domains_list", domain: "domains", action: "GetClientsDomains", tier: "read", sampleInput: {} },
  {
    name: "domains_whois_availability",
    domain: "domains",
    action: "DomainWhois",
    tier: "read",
    sampleInput: { domain: "example.com" },
  },
  {
    name: "domains_get_nameservers",
    domain: "domains",
    action: "DomainGetNameservers",
    tier: "read",
    sampleInput: { domainid: 1 },
  },
  {
    name: "domains_update_nameservers",
    domain: "domains",
    action: "DomainUpdateNameservers",
    tier: "write",
    sampleInput: { domainid: 1, ns1: "ns1.example.com", ns2: "ns2.example.com" },
    requiresConfirm: true,
  },
  {
    name: "domains_get_locking_status",
    domain: "domains",
    action: "DomainGetLockingStatus",
    tier: "read",
    sampleInput: { domainid: 1 },
  },
  {
    name: "domains_update_locking_status",
    domain: "domains",
    action: "DomainUpdateLockingStatus",
    tier: "write",
    sampleInput: { domainid: 1, lockstatus: true },
    requiresConfirm: true,
  },
  {
    name: "domains_get_whois_info",
    domain: "domains",
    action: "DomainGetWhoisInfo",
    tier: "read",
    sampleInput: { domainid: 1 },
  },
  {
    name: "domains_update",
    domain: "domains",
    action: "UpdateClientDomain",
    tier: "write",
    sampleInput: { domainid: 1, notes: "Contract test" },
  },
  {
    name: "domains_renew",
    domain: "domains",
    action: "DomainRenew",
    tier: "billing",
    sampleInput: { domainid: 1, regperiod: 1 },
    requiresConfirm: true,
  },
  {
    name: "domains_register",
    domain: "domains",
    action: "DomainRegister",
    tier: "billing",
    sampleInput: { domainid: 1 },
    requiresConfirm: true,
  },
  {
    name: "domains_transfer",
    domain: "domains",
    action: "DomainTransfer",
    tier: "billing",
    sampleInput: { domainid: 1, eppcode: "REDACTED-EPP" },
    requiresConfirm: true,
  },
  { name: "domains_get_tld_pricing", domain: "domains", action: "GetTLDPricing", tier: "read", sampleInput: {} },

  // --- orders ---
  { name: "orders_list", domain: "orders", action: "GetOrders", tier: "read", sampleInput: {} },
  { name: "orders_get_statuses", domain: "orders", action: "GetOrderStatuses", tier: "read", sampleInput: {} },
  {
    name: "orders_create",
    domain: "orders",
    action: "AddOrder",
    tier: "billing",
    sampleInput: {
      clientid: 1,
      paymentmethod: "mock",
      items: [{ pid: 1, billingcycle: "monthly" }],
      noinvoice: true,
    },
    requiresConfirm: true,
  },
  {
    name: "orders_accept",
    domain: "orders",
    action: "AcceptOrder",
    tier: "write",
    sampleInput: { orderid: 1 },
    requiresConfirm: true,
  },
  { name: "orders_pending", domain: "orders", action: "PendingOrder", tier: "write", sampleInput: { orderid: 1 } },
  {
    name: "orders_cancel",
    domain: "orders",
    action: "CancelOrder",
    tier: "destructive",
    sampleInput: { orderid: 1 },
    requiresConfirm: true,
  },
  {
    name: "orders_mark_fraud",
    domain: "orders",
    action: "FraudOrder",
    tier: "destructive",
    sampleInput: { orderid: 1 },
    requiresConfirm: true,
  },
  {
    name: "orders_delete",
    domain: "orders",
    action: "DeleteOrder",
    tier: "destructive",
    sampleInput: { orderid: 1 },
    requiresConfirm: true,
  },
];

const ALL_DOMAINS = [...new Set(TOOL_FIXTURES.map((t) => t.domain))].sort();

/* -------------------------------------------------------------------------
 * Test harness
 * ---------------------------------------------------------------------- */

let mock: MockWhmcsServer;
let apiUrl: string;

beforeAll(async () => {
  mock = await startMockWhmcsServer();
  const address = mock.server.address() as AddressInfo;
  apiUrl = `http://127.0.0.1:${address.port}/includes/api.php`;
});

afterAll(async () => {
  await mock.close();
});

afterEach(() => {
  mock.resetCallLog();
});

/** Builds a tool registry in a given mode/domain configuration against the mock. */
function buildRegistryFor(mode: WhmcsMcpMode, enabledDomains?: readonly string[]): {
  client: WhmcsClient;
  tools: ReadonlyMap<string, RegisteredTool>;
} {
  const client = createWhmcsClient({
    apiUrl,
    identifier: "mcp-test-identifier",
    secret: "mcp-test-secret",
    timeoutMs: 5_000,
    rateLimitPerSecond: 100,
  });
  const tools = buildToolRegistry({
    client,
    mode,
    enabledDomains: enabledDomains ?? ALL_DOMAINS,
    redactPii: true,
  });
  return { client, tools };
}

/* -------------------------------------------------------------------------
 * 1. Coverage meta-test: every fixture must exist in the built registry
 *    (full mode, all domains enabled) with the expected tier.
 * ---------------------------------------------------------------------- */

describe("tool registry coverage", () => {
  const { tools } = buildRegistryFor("full", ALL_DOMAINS);

  it.each(TOOL_FIXTURES.map((f) => [f.name, f] as const))(
    "registers %s with the tier declared in the architecture plan",
    (_name, fixture) => {
      const tool = tools.get(fixture.name);
      expect(tool, `expected tool "${fixture.name}" to be registered`).toBeDefined();
      expect(tool!.tier).toBe(fixture.tier);
      expect(tool!.domain).toBe(fixture.domain);
    },
  );

  it("registers exactly the tool set the plan declares (no drift)", () => {
    const expected = new Set(TOOL_FIXTURES.map((f) => f.name));
    const actual = new Set(tools.keys());
    expect([...actual].sort()).toEqual([...expected].sort());
  });
});

/* -------------------------------------------------------------------------
 * 2. Schema -> WHMCS param serialization + result shape, per tool.
 *
 *    Runs every read-tier and write-tier tool's sampleInput through the
 *    real handler against the mock server, and asserts:
 *      - the mock received the expected `action`
 *      - identifier/secret were present on every request (auth injection)
 *      - the tool's result carries structuredContent (not just text)
 *      - billing/destructive tools without a confirmToken return a
 *        preview + confirmToken instead of calling WHMCS
 * ---------------------------------------------------------------------- */

describe("schema -> WHMCS param serialization and result shape", () => {
  const { tools } = buildRegistryFor("full", ALL_DOMAINS);

  for (const fixture of TOOL_FIXTURES) {
    it(`${fixture.name} serializes its input and returns structured content`, async () => {
      const tool = tools.get(fixture.name);
      expect(tool).toBeDefined();

      const parsed = tool!.inputSchema.safeParse(fixture.sampleInput);
      expect(parsed.success, `input schema rejected sample input: ${JSON.stringify(parsed as unknown)}`).toBe(true);

      const result = await tool!.handler(fixture.sampleInput as never);

      expect(result).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);

      if (fixture.requiresConfirm) {
        // First call with no confirmToken must preview, not mutate.
        expect(result.structuredContent).toMatchObject({ status: "confirmation_required" });
        expect(typeof (result.structuredContent as Record<string, unknown>).confirmToken).toBe("string");
        expect(mock.callLog.some((c) => c.action === fixture.action)).toBe(false);
      } else {
        expect(result.structuredContent).toBeDefined();
        if (fixture.action !== "<dynamic>") {
          expect(mock.callLog.some((c) => c.action === fixture.action)).toBe(true);
        }
        const call = mock.callLog.find((c) => c.action === fixture.action);
        if (call) {
          expect(call.params.identifier).toBe("mcp-test-identifier");
          expect(call.params.secret).toBe("mcp-test-secret");
          expect(call.params.responsetype).toBe("json");
        }
      }
    });
  }
});

/* -------------------------------------------------------------------------
 * 3. Confirm-token flow: second call with the echoed token executes.
 * ---------------------------------------------------------------------- */

describe("two-step confirmation flow for billing/destructive tools", () => {
  const confirmFixtures = TOOL_FIXTURES.filter((f) => f.requiresConfirm && f.action !== "<dynamic>");

  it.each(confirmFixtures.map((f) => [f.name, f] as const))(
    "%s executes against WHMCS once the confirmToken is echoed back",
    async (_name, fixture) => {
      const { tools } = buildRegistryFor("full", ALL_DOMAINS);
      const tool = tools.get(fixture.name)!;

      const preview = await tool.handler(fixture.sampleInput as never);
      const previewBody = preview.structuredContent as { status: string; confirmToken: string };
      expect(previewBody.status).toBe("confirmation_required");

      const confirmed = await tool.handler({
        ...fixture.sampleInput,
        confirmToken: previewBody.confirmToken,
      } as never);

      expect(mock.callLog.some((c) => c.action === fixture.action)).toBe(true);
      expect(confirmed.structuredContent).toBeDefined();
      expect((confirmed.structuredContent as Record<string, unknown>).status).not.toBe("confirmation_required");
    },
  );

  it("rejects a confirmToken that does not match the args it was issued for", async () => {
    const { tools } = buildRegistryFor("full", ALL_DOMAINS);
    const tool = tools.get("clients_close")!;

    const preview = await tool.handler({ clientid: 1 } as never);
    const { confirmToken } = preview.structuredContent as { confirmToken: string };

    await expect(
      tool.handler({ clientid: 999, confirmToken } as never),
    ).rejects.toThrow(/confirm/i);

    expect(mock.callLog.some((c) => c.action === "CloseClient")).toBe(false);
  });

  it("dryRun never reaches WHMCS even with a valid confirmToken", async () => {
    const { tools } = buildRegistryFor("full", ALL_DOMAINS);
    const tool = tools.get("services_module_terminate")!;

    const preview = await tool.handler({ serviceid: 1, dryRun: true } as never);
    const body = preview.structuredContent as { status: string; confirmToken?: string };

    if (body.confirmToken) {
      const result = await tool.handler({ serviceid: 1, dryRun: true, confirmToken: body.confirmToken } as never);
      expect((result.structuredContent as Record<string, unknown>).dryRun).toBe(true);
    }
    expect(mock.callLog.some((c) => c.action === "ModuleTerminate")).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * 4. Mode filtering: readonly | write | full
 * ---------------------------------------------------------------------- */

describe("mode filtering", () => {
  it("readonly mode advertises only read-tier tools", () => {
    const { tools } = buildRegistryFor("readonly", ALL_DOMAINS);
    expect(tools.size).toBeGreaterThan(0);
    for (const tool of tools.values()) {
      expect(tool.tier).toBe("read");
    }
    // Spot-check a few that must be excluded.
    expect(tools.has("tickets_create")).toBe(false);
    expect(tools.has("billing_create_invoice")).toBe(false);
    expect(tools.has("orders_cancel")).toBe(false);
  });

  it("write mode advertises read and write tier tools, never billing or destructive", () => {
    const { tools } = buildRegistryFor("write", ALL_DOMAINS);
    for (const tool of tools.values()) {
      expect(["read", "write"]).toContain(tool.tier);
    }
    expect(tools.has("tickets_create")).toBe(true);
    expect(tools.has("billing_create_invoice")).toBe(false);
    expect(tools.has("orders_cancel")).toBe(false);
    expect(tools.has("services_module_terminate")).toBe(false);
  });

  it("full mode advertises every tier including billing and destructive", () => {
    const { tools } = buildRegistryFor("full", ALL_DOMAINS);
    const tiers = new Set([...tools.values()].map((t) => t.tier));
    expect(tiers).toEqual(new Set<ToolTier>(["read", "write", "billing", "destructive"]));
    expect(tools.has("billing_create_invoice")).toBe(true);
    expect(tools.has("billing_update_invoice")).toBe(true);
    expect(tools.has("billing_add_payment")).toBe(true);
    expect(tools.has("billing_apply_credit")).toBe(true);
    expect(tools.has("billing_capture_payment")).toBe(true);
  });

  it("defaults to readonly when mode is unspecified", () => {
    const client = createWhmcsClient({
      apiUrl,
      identifier: "id",
      secret: "secret",
      timeoutMs: 5_000,
      rateLimitPerSecond: 100,
    });
    const tools = buildToolRegistry({ client, enabledDomains: ALL_DOMAINS, redactPii: true } as never);
    for (const tool of tools.values()) {
      expect(tool.tier).toBe("read");
    }
  });

  it("the billing tier stays disabled in full mode only via explicit opt-in, never implicitly through write", () => {
    // Regression guard for the operator's standing "invoices are operator-manual"
    // rule: no combination of flags other than an explicit mode:"full" may
    // surface an invoice-mutating tool.
    for (const mode of ["readonly", "write"] as const) {
      const { tools } = buildRegistryFor(mode, ALL_DOMAINS);
      for (const billingTool of [
        "billing_create_invoice",
        "billing_update_invoice",
        "billing_add_payment",
        "billing_apply_credit",
        "billing_capture_payment",
      ]) {
        expect(tools.has(billingTool)).toBe(false);
      }
    }
  });
});

/* -------------------------------------------------------------------------
 * 5. Domain filtering: WHMCS_MCP_ENABLE_DOMAINS
 * ---------------------------------------------------------------------- */

describe("domain filtering", () => {
  it("only advertises tools from enabled domains", () => {
    const { tools } = buildRegistryFor("full", ["tickets", "system"]);
    for (const tool of tools.values()) {
      expect(["tickets", "system"]).toContain(tool.domain);
    }
    expect(tools.has("clients_list")).toBe(false);
    expect(tools.has("billing_list_invoices")).toBe(false);
    expect(tools.has("tickets_list")).toBe(true);
    expect(tools.has("system_get_details")).toBe(true);
  });

  it("an empty domain list advertises no tools", () => {
    const { tools } = buildRegistryFor("full", []);
    expect(tools.size).toBe(0);
  });

  it("mode and domain filters compose (intersection, not union)", () => {
    const { tools } = buildRegistryFor("readonly", ["invoices"]);
    // Only read-tier invoices tools should surface.
    for (const tool of tools.values()) {
      expect(tool.domain).toBe("invoices");
      expect(tool.tier).toBe("read");
    }
    expect(tools.has("billing_list_invoices")).toBe(true);
    expect(tools.has("billing_create_invoice")).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * 6. Collection normalization: WHMCS's nested {tickets:{ticket:[...]}}-style
 *    shapes must come back as plain arrays in structuredContent.
 * ---------------------------------------------------------------------- */

describe("nested-collection normalization", () => {
  it("tickets_list normalizes GetTickets' nested tickets.ticket[] into a flat array", async () => {
    const { tools } = buildRegistryFor("full", ALL_DOMAINS);
    const result = await tools.get("tickets_list")!.handler({ limitnum: 25 } as never);
    const body = result.structuredContent as { tickets: unknown[] };
    expect(Array.isArray(body.tickets)).toBe(true);
  });

  it("clients_list normalizes GetClients' nested clients.client[] into a flat array", async () => {
    const { tools } = buildRegistryFor("full", ALL_DOMAINS);
    const result = await tools.get("clients_list")!.handler({ limitnum: 25 } as never);
    const body = result.structuredContent as { clients: unknown[] };
    expect(Array.isArray(body.clients)).toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * 7. Redaction: even in full/read mode, secrets never leak in results.
 * ---------------------------------------------------------------------- */

describe("redaction is applied to every tool result", () => {
  it("clients_get never surfaces a raw password/secret field", async () => {
    const { tools } = buildRegistryFor("full", ALL_DOMAINS);
    const result = await tools.get("clients_get")!.handler({ clientid: 1 } as never);
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).not.toMatch(/"password2?"\s*:\s*"(?!\[REDACTED\])[^"]+"/i);
  });

  it("billing_get_pay_methods never surfaces a full card/bank number", async () => {
    const { tools } = buildRegistryFor("full", ALL_DOMAINS);
    const result = await tools.get("billing_get_pay_methods")!.handler({ clientid: 1 } as never);
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).not.toMatch(/\b\d{12,19}\b/);
  });
});
