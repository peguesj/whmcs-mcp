# @peguesj/whmcs-mcp

An MCP (Model Context Protocol) server for the [WHMCS External API](https://developers.whmcs.com/api-reference/) — built for safe production use, not just convenience.

Read-only by default. Write actions are opt-in per domain. Billing and destructive actions require a two-step confirmation. Secrets, card data, and PII are redacted before results ever reach the model. The server detects your WHMCS version at startup and warns on unsupported installs.

Tested against the WHMCS 8.12.x and 9.0.x External API contract (action names and parameters are unchanged across that range).

## Why a new one

Several WHMCS MCP servers already exist. None combines an open MIT license, a TypeScript/npm-native implementation, typed per-action zod schemas, and a tiered safety model in one place:

| Project | License | Language | Notes |
|---|---|---|---|
| [`theorigamicorporation/toc-whmcs-mcp`](https://github.com/theorigamicorporation/toc-whmcs-mcp) | AGPL-3.0 | Go | Closest in spirit — read-only default, confirmation-gated mutations, redacted output, ~15-25 tools advertised per profile out of 162 documented actions. We borrowed the "small advertised tool list" idea. |
| [`daddariotech/whmcs-mcp`](https://github.com/daddariotech/whmcs-mcp) | Commercial | TypeScript | 98 tools, `dryRun` everywhere, documents minimum API-role permission per tool, requires a paid license key. We borrowed the per-tool permission docs and `dryRun` pattern, but stay fully open source. |
| [`caioldcarvalho/whmcs-mcp`](https://github.com/caioldcarvalho/whmcs-mcp) (npm `whmcs-mcp`) | MIT | TypeScript | 34 tools, no tiered safety model. Holds the unscoped npm name, which is why we publish as `@peguesj/whmcs-mcp`. |
| [`not-sure-w/whmcs-mcp-server`](https://github.com/not-sure-w/whmcs-mcp-server) (npm `whmcs-mcp-server`) | ISC | TypeScript | 60+ tools, last published 2026-04. Holds the `whmcs-mcp-server` npm name. |
| [`scarecr0w12/whmcs-mcp-tool`](https://github.com/scarecr0w12/whmcs-mcp-tool) | MIT | — | Most-starred of the group; ships CI, a GHCR Docker image, and a generated `docs/API_REFERENCE.md`. We borrowed the Docker/GHCR distribution and generated-reference pattern. |

This project differentiates on **safety posture** (tiered mode matrix, confirm-token flow, deep redaction), **license** (MIT, no paid tier), **typed schemas** (one zod schema per WHMCS action, not a generic dispatcher), **version awareness** (runtime `WhmcsDetails` check), and **documentation quality** (generated tool reference, marketing site with real usage examples against mock data).

## Install

```bash
npm install -g @peguesj/whmcs-mcp
# or run without installing:
npx @peguesj/whmcs-mcp
```

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "whmcs": {
      "command": "npx",
      "args": ["-y", "@peguesj/whmcs-mcp"],
      "env": {
        "WHMCS_API_URL": "https://your-whmcs-install.example.com/includes/api.php",
        "WHMCS_API_IDENTIFIER": "your-api-identifier",
        "WHMCS_API_SECRET": "your-api-secret",
        "WHMCS_MCP_MODE": "readonly"
      }
    }
  }
}
```

### From source

```bash
git clone https://github.com/peguesj/whmcs-mcp.git
cd whmcs-mcp
npm install
npm run build
cp .env.example .env   # fill in your own values — never commit real credentials
node dist/index.js
```

## Quickstart

1. In WHMCS admin, create a dedicated **API Credential** (Setup → Staff Management → Manage API Credentials, or the legacy API user under System Settings) and, if your WHMCS version supports it, an **API Role** scoped to only the actions you intend to expose. Least-privilege first — see [`SECURITY.md`](./SECURITY.md) for a recommended role recipe.
2. Set `WHMCS_API_URL`, `WHMCS_API_IDENTIFIER`, and `WHMCS_API_SECRET` (see [`.env.example`](./.env.example)).
3. Leave `WHMCS_MCP_MODE` unset or `readonly` for your first run. Confirm the server starts and `system_get_details` reports your WHMCS version.
4. Add domains you need with `WHMCS_MCP_ENABLE_DOMAINS` (defaults to all domains, filtered by mode/tier).
5. Only set `WHMCS_MCP_MODE=write` or `full` once you have reviewed [Safety model](#safety-model) below and understand what each mode exposes.

## Safety model

Every tool has a **tier**:

| Tier | Meaning | Example |
|---|---|---|
| `read` | No side effects. Always advertised. | `tickets_list`, `clients_get` |
| `write` | Mutates non-billing state (tickets, contacts, DNS, service metadata). | `tickets_reply`, `domains_update_nameservers` |
| `billing` | Mutates invoices, payments, credits, orders, or domain registration/transfer/renewal. Confirmation-gated and off unless `WHMCS_MCP_MODE=full`. | `billing_create_invoice`, `domains_register` |
| `destructive` | Irreversible or hard-to-reverse (delete, merge, terminate, cancel, mark fraud). Always confirmation-gated. | `tickets_delete`, `services_module_terminate` |

And every deployment has a **mode**, set via `WHMCS_MCP_MODE`:

| Mode | `read` | `write` | `billing` | `destructive` |
|---|---|---|---|---|
| `readonly` (default) | advertised | hidden | hidden | hidden |
| `write` | advertised | advertised | hidden | advertised (confirm required) |
| `full` | advertised | advertised | advertised (confirm required) | advertised (confirm required) |

`WHMCS_MCP_ENABLE_DOMAINS` (comma-separated: `tickets,clients,products,invoices,domains,orders,system`) further narrows which domains' tools are registered at all, independent of mode.

**Two-step confirmation** (`billing` and `destructive` tiers): the first call to a gated tool returns a human-readable preview plus a short-lived, single-use `confirmToken` (HMAC-signed, 5-minute TTL, bound to the tool name and a hash of its arguments). The caller must repeat the call with that exact token to execute. Every mutating tool also accepts `dryRun: true`, which returns the same preview and makes no network call at all — no token needed, no state changed.

**Redaction** runs on every response and on error messages before they leave the process: API secrets, session/access keys, stored passwords, full card and bank account numbers, CVV, and EPP transfer codes are always stripped. Email, phone, and address fields are redacted when `WHMCS_MCP_REDACT_PII=true` (the recommended default for any shared or logged transcript).

**Operator policy note:** this project ships with the invoice-mutating tools (`billing_create_invoice`, `billing_update_invoice`, `billing_add_payment`, `billing_apply_credit`, `billing_capture_payment`) in the `billing` tier specifically so an operator can enforce "no agent writes to WHMCS invoices" by simply never setting `WHMCS_MCP_MODE=full`. Do not enable `full` mode in a deployment where invoice mutation must stay human-only.

See [`SECURITY.md`](./SECURITY.md) for the full threat model and the recommended least-privilege WHMCS API role.

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `WHMCS_API_URL` | yes | — | Full URL to `includes/api.php` on your WHMCS install. Must be HTTPS unless `WHMCS_MCP_ALLOW_INSECURE=true`. |
| `WHMCS_API_IDENTIFIER` | yes | — | API credential identifier. |
| `WHMCS_API_SECRET` | yes | — | API credential secret. Never logged. |
| `WHMCS_API_ACCESS_KEY` | no | — | Optional `accesskey` param, if your WHMCS install enforces one instead of / in addition to an IP allowlist. |
| `WHMCS_MCP_MODE` | no | `readonly` | `readonly` \| `write` \| `full`. See [Safety model](#safety-model). |
| `WHMCS_MCP_ENABLE_DOMAINS` | no | all domains | Comma-separated domain filter: `tickets,clients,products,invoices,domains,orders,system`. |
| `WHMCS_MCP_REDACT_PII` | no | `true` | Redact email/phone/address in tool output in addition to the always-on secret/card redaction. |
| `WHMCS_MCP_TIMEOUT_MS` | no | `15000` | Per-request timeout to the WHMCS API. |
| `WHMCS_MCP_RATE_LIMIT` | no | `5` (req/s) | Token-bucket rate limit applied to outgoing WHMCS API calls. |
| `WHMCS_MCP_ALLOW_INSECURE` | no | `false` | Allows `WHMCS_API_URL` to be `http://`. Only for local mock/dev testing. |

Full details, including per-tool minimum API-role permissions: [`docs/configuration.md`](./docs/configuration.md). WHMCS 8.x/9.x compatibility notes: [`docs/version-compatibility.md`](./docs/version-compatibility.md).

## Tools

The full generated tool reference — every tool, its tier, its WHMCS action, and its parameters — lives in **[`docs/tools.md`](./docs/tools.md)** (regenerated from the zod schemas via `npm run gen:docs`, also published as `site/data/tools.json` for the marketing site's tool catalog).

At a glance, tools are grouped by domain, mirroring `src/tools/`:

- **`system`** — `system_get_details` (version discovery), `system_get_stats`, `system_get_activity_log`, `system_get_admin_details`, `system_get_todo_items`, `system_get_email_templates`, `system_send_email`, `system_get_payment_methods`, `system_get_currencies`, `system_log_activity`, plus the `whmcs_raw_call` escape hatch (full mode only, allowlisted actions, confirm-gated).
- **`tickets`** — list/get/create/reply/update/note/merge/delete tickets, attachments, counts, departments, statuses, predefined replies.
- **`clients`** — list/get/create/update/close clients, contacts, client emails, client groups.
- **`products`** — product/promotion lookups, client services and addons, service and addon updates, module lifecycle (create/suspend/unsuspend/terminate/change-package), product/config-option upgrades.
- **`invoices`** — invoice list/get/create/update, payments, credits, transactions, billable items, saved pay methods, and quotes (list/create/update/send).
- **`domains`** — client domain list, WHOIS lookup and availability, nameservers, locking, renew/register/transfer, TLD pricing.
- **`orders`** — order list/create/accept/pending/cancel/fraud/delete, order statuses.

Example call (MCP tool invocation shown as JSON-RPC-style params):

```json
{
  "name": "tickets_list",
  "arguments": { "status": "Open", "limitnum": 25 }
}
```

Example of a confirm-gated mutation:

```json
// 1. First call — preview only, no network mutation
{ "name": "tickets_delete", "arguments": { "ticketid": 4821 } }
// -> { "preview": "Delete ticket #4821 (subject: ...) — irreversible", "confirmToken": "eyJ..." }

// 2. Second call — echoes the token to execute
{ "name": "tickets_delete", "arguments": { "ticketid": 4821, "confirmToken": "eyJ..." } }
```

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run lint
npm test              # vitest against an in-process mock WHMCS server (test/mock-whmcs-server.ts)
npm run gen:docs       # regenerate docs/tools.md and site/data/tools.json from the tool registry
npm run screenshots    # Playwright captures against MCP Inspector + the mock server, for site/assets/screenshots
npm run pack:check     # npm pack --dry-run
```

The mock WHMCS server serves synthetic fixture data only (`test/fixtures/`) — screenshots and tests never touch a real WHMCS instance or real client data.

## Docker

```bash
docker build -t whmcs-mcp .
docker run --rm -i \
  -e WHMCS_API_URL -e WHMCS_API_IDENTIFIER -e WHMCS_API_SECRET \
  -e WHMCS_MCP_MODE=readonly \
  whmcs-mcp
```

The image is a multi-stage build onto a distroless Node runtime, running as a non-root user, with `stdio` as the default transport.

## Security

See [`SECURITY.md`](./SECURITY.md) for the threat model, the recommended least-privilege WHMCS API role, the billing-tier policy, and how to report a vulnerability.

## License

[MIT](./LICENSE) © Jeremiah Pegues
