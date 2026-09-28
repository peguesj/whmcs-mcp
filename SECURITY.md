# Security Policy

`@peguesj/whmcs-mcp` gives a Model Context Protocol client (Claude, another
LLM agent, or any MCP host) programmatic access to a WHMCS instance's
External API. WHMCS is a billing system of record: client PII, payment
instruments, support communications, and invoicing all live behind the
credentials this server holds. This document describes the threat model,
the least-privilege WHMCS API role this server expects, the billing-tier
policy, and how to report a vulnerability.

If you are deploying this server against a production WHMCS instance,
read this document in full before setting `WHMCS_MCP_MODE` to anything
other than `readonly`.

## 1. Threat model

### 1.1 Assets protected

- **Client PII**: names, emails, phone numbers, addresses, service
  credentials, ticket contents.
- **Payment data**: masked card/bank references, gateway transaction IDs,
  CVV (transient, never persisted by this server).
- **Billing state**: invoices, credits, transactions, quotes, orders —
  mutating these has real financial and contractual consequences.
- **Domain control**: nameservers, registrar locks, EPP/auth codes —
  mutating these can transfer or hijack a domain.
- **WHMCS API credentials themselves** (`identifier` / `secret` /
  optional `accesskey`), which are equivalent to whatever permissions the
  bound WHMCS API Role grants.

### 1.2 Actors and trust boundaries

```
 ┌─────────────┐   MCP (stdio / loopback HTTP)   ┌──────────────────┐   HTTPS POST   ┌─────────────┐
 │ MCP client  │ ───────────────────────────────▶│  whmcs-mcp       │──────────────▶│ WHMCS        │
 │ (LLM agent, │◀─────────────────────────────── │  (this server)   │◀────────────── │ External API │
 │ IDE, host)  │        tool results (redacted)   └──────────────────┘   JSON result  │ /includes/   │
 └─────────────┘                                                                       │ api.php      │
                                                                                        └─────────────┘
```

- **MCP client → server**: trusted transport (local stdio by default, or
  loopback-only Streamable HTTP with `--http`). The server does **not**
  bind to a non-loopback interface and refuses to start if asked to
  without an explicit override, because MCP's stdio/HTTP surface has no
  built-in caller authentication of its own beyond the transport.
- **Server → WHMCS**: the only network egress this process makes. It is
  the sole holder of the WHMCS API credentials; they never cross back to
  the MCP client, and are never included in a tool result, log line, or
  error message (see §1.4, §3).
- **LLM agent as an untrusted actor toward WHMCS**: the actor driving the
  MCP client is an LLM whose behavior is probabilistic and whose inputs
  may include untrusted third-party text (a ticket reply, a client-typed
  invoice note, a scraped page). This server assumes the model can be
  induced, via prompt injection or reasoning error, into requesting an
  action it should not take — so authorization is enforced in code
  (mode/domain/tier gating, confirmation tokens), never by asking the
  model to "please only do read-only things."

### 1.3 Primary threats considered

| # | Threat | Mitigation |
|---|--------|------------|
| T1 | Prompt injection in ticket/invoice/quote text causes the agent to invoke a destructive or billing tool it was not asked to run | Tiered tool advertisement (`WHMCS_MCP_MODE`), two-step `confirmToken` gate on every `billing`/`destructive` tool, `dryRun` support on all mutating tools |
| T2 | Credential leakage via logs, error messages, or tool output | `src/safety/redact.ts` runs on every outbound payload and on error messages before they reach stdout/the model; `src/logger.ts` writes only to stderr and never logs request bodies |
| T3 | Overexposed WHMCS API role lets the server (and therefore the model) do more than the deployment needs | Least-privilege role recipe in §2; `WHMCS_MCP_ENABLE_DOMAINS` restricts the tool surface independently of what the bound role can technically do |
| T4 | Accidental invoice mutation by an agent, contradicting the operator's manual-invoice policy | Invoice-mutating tools ship in the `billing` tier, which is off unless `WHMCS_MCP_MODE=full`; see §3 |
| T5 | Compromised or malicious MCP client on the same host reaches WHMCS through this server | Server binds loopback-only for HTTP transport; stdio transport has no network listener at all; no bearer-token bypass is implemented |
| T6 | Card/EPP/CVV data flows through the LLM's context window | Card and bank fields are always masked at the client layer (`GetPayMethods`, `GetClientsDetails`) regardless of redaction settings; CVV is accepted only as a pass-through parameter for `billing_capture_payment` and is never echoed, logged, or included in tool output |
| T7 | Rate-limit or retry storms against a production WHMCS instance | Token-bucket rate limiting and bounded retry-with-backoff on idempotent reads only (never on writes) in `src/whmcs-client.ts` |
| T8 | Screenshot/documentation assets leak real client data | Marketing screenshots are captured exclusively against `test/mock-whmcs-server.ts` synthetic fixtures; no tool in this repo is ever pointed at a live WHMCS instance during doc/screenshot generation |
| T9 | Supply-chain compromise via a dependency | Runtime dependency surface is deliberately minimal: `@modelcontextprotocol/sdk` and `zod` only (native `fetch`, no HTTP client dependency); `npm pack --dry-run` and a secret scan run in CI before any publish |

### 1.4 What this server explicitly does NOT do

- It does not implement its own authentication/authorization for MCP
  clients — it trusts the transport (stdio parent process, or an operator
  who chose to run `--http` and is responsible for restricting who can
  reach loopback on that host).
- It does not cache or persist WHMCS credentials outside process memory,
  and holds them in a non-enumerable config object (`src/config.ts`) so
  they do not appear in casual object dumps.
- It does not retry write operations automatically (a retried
  non-idempotent write against a billing system is a correctness bug
  waiting to happen).
- It does not fall back to an insecure transport silently: `WHMCS_API_URL`
  must be `https://` unless `WHMCS_MCP_ALLOW_INSECURE=true` is set
  explicitly, which should only ever be used against a local mock.

## 2. Least-privilege WHMCS API role

Do not point this server at an Administrator-equivalent API identifier.
WHMCS API Roles (Setup → Staff Management → API Credentials) let you scope
exactly which of the ~150+ documented actions an identifier/secret pair
may call. Create a role named e.g. `mcp-readonly` (or `mcp-write`,
`mcp-full` — one identifier per intended `WHMCS_MCP_MODE`) and grant only
the actions the enabled domains need.

### 2.1 Recipe: `readonly` mode (recommended default, including production)

Enable only these documented actions on the API Role:

```
WhmcsDetails, GetStats, GetActivityLog, GetAdminDetails, GetToDoItems,
GetEmailTemplates, GetPaymentMethods, GetCurrencies,
GetTickets, GetTicket, GetTicketNotes, GetTicketAttachment,
GetTicketCounts, GetSupportDepartments, GetSupportStatuses,
GetTicketPredefinedReplies,
GetClients, GetClientsDetails, GetContacts, GetEmails, GetClientGroups,
GetClientsProducts, GetClientsAddons,
GetProducts, GetPromotions,
GetInvoices, GetInvoice, GetCredits, GetTransactions, GetPayMethods,
GetQuotes,
GetClientsDomains, DomainWhois, DomainGetNameservers,
DomainGetLockingStatus, DomainGetWhoisInfo, GetTLDPricing,
GetOrders, GetOrderStatuses
```

This is the action set behind every tool tagged `[read]` in
`docs/tools.md`. It grants zero mutation capability at the WHMCS layer —
even if this server had a bug that bypassed its own mode gating, the
credential itself could not write anything.

### 2.2 Recipe: `write` mode

Everything in §2.1, plus the non-billing mutation actions:

```
SendEmail, LogActivity,
OpenTicket, AddTicketReply, AddTicketNote, UpdateTicket, UpdateTicketReply,
AddClient, UpdateClient, AddContact, UpdateContact,
UpdateClientProduct, UpdateClientAddon,
ModuleCreate, ModuleSuspend, ModuleUnsuspend, ModuleChangePackage,
DomainUpdateNameservers, DomainUpdateLockingStatus, UpdateClientDomain,
AcceptOrder, PendingOrder,
SendQuote
```

Destructive actions (`MergeTicket`, `DeleteTicket`, `CloseClient`,
`ModuleTerminate`, `CancelOrder`, `FraudOrder`, `DeleteOrder`) are gated by
this server's `destructive` tier and require `WHMCS_MCP_MODE=write` **and**
an explicit confirm-token round trip; grant them on the role only if the
deployment genuinely needs an agent to close tickets/accounts/services.
Prefer leaving them off the role even in `write` mode and performing those
actions by hand, mirroring the operator policy in §3.

### 2.3 Recipe: `full` mode (billing tier — opt-in, non-default)

Everything in §2.1–2.2, plus:

```
CreateInvoice, UpdateInvoice, AddInvoicePayment, ApplyCredit,
CapturePayment, AddCredit, AddBillableItem,
CreateQuote, UpdateQuote,
UpgradeProduct,
DomainRenew, DomainRegister, DomainTransfer,
AddOrder
```

See §3 — this tier ships disabled by default and must stay disabled in
any 3VS/production deployment configuration regardless of what the bound
role permits.

### 2.4 Additional role hardening

- **IP allowlist**: WHMCS API Credentials support restricting the
  identifier to specific source IPs. Set this to the fixed egress IP of
  the host running this server wherever the hosting environment makes
  that possible.
- **Access key**: set `WHMCS_API_ACCESS_KEY` (WHMCS's optional
  `$api_access_key` / `accesskey` parameter) as a second factor alongside
  identifier/secret when the WHMCS configuration supports it.
- **One role per mode**: do not reuse a `full`-capable identifier for a
  `readonly` deployment "for convenience." A leaked `readonly` credential
  should be inert; that property only holds if the role itself has no
  write actions enabled.
- **Rotate on suspected exposure**: rotating the identifier/secret in
  WHMCS immediately invalidates any leaked copy; this server holds no
  other durable credential material.

## 3. Billing-tier policy

The operator's standing rule for this environment is: **invoices are
operator-manual — no agent writes to WHMCS invoices** (create, edit,
cancel, publish, or change payment method), regardless of any other
approval given for the session.

This server encodes that rule structurally, not just as a convention:

- `billing_create_invoice`, `billing_update_invoice`,
  `billing_add_payment`, `billing_apply_credit`, and
  `billing_capture_payment` are all tagged tier `billing` in
  `src/tools/invoices.ts` / `src/safety/policy.ts`.
- The `billing` tier is only advertised to an MCP client when
  `WHMCS_MCP_MODE=full`. In `readonly` (the default) and `write` modes,
  these tools do not exist as far as the connected model can see — there
  is nothing to be tricked into calling.
- Every `billing`-tier tool additionally requires the two-step
  `confirmToken` flow (`src/safety/confirm.ts`): a first call returns a
  human-readable preview and a short-lived (5 minute), single-use,
  HMAC-bound token; the mutation only executes if a second call echoes
  that exact token against the same tool and arguments. `dryRun: true`
  short-circuits before any network call.
- **`WHMCS_MCP_MODE=full` must never be set in a 3VS/production
  deployment configuration.** It exists for local development against the
  mock server and for a deliberately separate, explicitly-approved
  environment where an operator has decided an agent may propose (not
  silently execute) billing mutations. Setting it does not itself bypass
  the confirm-token gate — it only makes the tools visible.
- Other domains follow the same shape at a lower blast radius: reads are
  always on; non-destructive writes need `WHMCS_MCP_MODE=write` or
  `full`; anything tagged `destructive` (ticket/order/client deletion or
  closure, service termination) needs the confirm-token round trip on top
  of that, independent of the billing question.

If a future integration needs the model to *draft* an invoice for a human
to review and send, the correct extension point is a read/preview tool
(e.g., an invoice line-item calculator) that never calls `CreateInvoice`
— not loosening this tier.

## 4. Data handling and redaction

- `src/safety/redact.ts` is applied to every tool result and to error
  messages before they leave the process. It strips: WHMCS credentials,
  passwords and password-confirmation fields, full card/bank account
  numbers (WHMCS's own API already returns these masked; the redactor is
  a second line of defense), CVV, domain EPP/auth codes, and — when
  `WHMCS_MCP_REDACT_PII=true` (recommended default) — email, phone, and
  postal address fields on client/contact records.
- Service passwords (`GetClientsProducts`) and newly-set account
  passwords are never echoed back in a tool result, even in `dryRun`
  previews.
- `src/logger.ts` writes exclusively to stderr (stdout is reserved for
  the MCP stdio transport) and never logs a raw request or response body
  — only method/action name, status, and timing.
- Marketing screenshots under `site/assets/screenshots/` are captured
  only against `test/mock-whmcs-server.ts`'s synthetic fixtures
  (`scripts/capture-screenshots.ts`). No tool, test, or documentation
  asset in this repository is ever run against a real WHMCS instance or
  real client data — that would risk publishing PII on a public GitHub
  Pages site, which the operator's data-handling rules forbid outright.

## 5. Version compatibility and integrity

- The External API contract used here (`identifier`/`secret` auth,
  action names, parameter shapes, API Roles) is unchanged across WHMCS
  8.x and 9.0.x. This server confirms the live version at startup via the
  `WhmcsDetails` action (exposed as the `system_get_details` tool and the
  `whmcs://system/version` resource) and logs a warning if the reported
  version is below 8.0, which is out of scope for this server's tested
  contract. See `docs/version-compatibility.md`.
- CI (`ci.yml`) runs `tsc --noEmit`, lint, the full Vitest suite against
  the mock server, a docs-drift check, and `npm pack --dry-run` on every
  change. A secret scan of the tree runs before any tagged release.

## 6. Deployment checklist

Before pointing this server at a real WHMCS instance:

- [ ] Created a dedicated WHMCS API Role scoped per §2 for the intended mode.
- [ ] `WHMCS_API_URL` is `https://…` (no `WHMCS_MCP_ALLOW_INSECURE`).
- [ ] `WHMCS_MCP_MODE` is the minimum the deployment needs (`readonly`
      unless a specific, approved use case requires more).
- [ ] `WHMCS_MCP_MODE=full` is **not** set for any 3VS/production config.
- [ ] `WHMCS_MCP_ENABLE_DOMAINS` lists only the domains actually needed by
      the connected agent's task.
- [ ] `WHMCS_MCP_REDACT_PII=true` unless there is a specific, reviewed
      reason to disable it.
- [ ] IP allowlist and/or `WHMCS_API_ACCESS_KEY` configured on the WHMCS
      side if supported by the hosting environment.
- [ ] If using `--http`, confirmed the process binds to `127.0.0.1` only
      and that nothing forwards that port externally.
- [ ] `.env` (or equivalent secret store) is not committed; only
      `.env.example` with placeholder values ships in the repo.

## 7. Reporting a vulnerability

If you find a security issue in this server (credential handling, an
authorization bypass, a redaction gap, an injection vector through WHMCS
response data, etc.), please report it privately rather than opening a
public GitHub issue:

- Open a [GitHub Security Advisory](https://github.com/peguesj/whmcs-mcp/security/advisories/new)
  on this repository (preferred — keeps the report private until a fix
  ships), or
- Email the maintainer listed in `package.json` (`author`) with a
  description of the issue, reproduction steps against
  `test/mock-whmcs-server.ts` where possible, and the affected version.

Please do not include real WHMCS credentials, real client data, or
screenshots of a live instance in a report — reproduce against the mock
server whenever the issue allows it. Do not open a public issue for an
unpatched vulnerability; give a reasonable window for a fix and a
coordinated disclosure before any public write-up.

This project has no bug bounty program. Well-documented reports that lead
to a fix will be credited in `CHANGELOG.md` if the reporter wants that.
