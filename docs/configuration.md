# Configuration

This page covers everything needed to stand up `@peguesj/whmcs-mcp` against a real WHMCS
instance: environment variables, the WHMCS API Role/Credential setup, IP allowlisting vs.
`accesskey`, the mode/domain matrix that controls which tools are advertised, and copy-paste
install snippets for Claude Desktop, Claude Code, and Cursor.

See also: [`version-compatibility.md`](./version-compatibility.md) for the 8.x/9.x contract
notes, and [`tools.md`](./tools.md) (generated) for the full tool reference.

---

## 1. Environment variables

All configuration is via environment variables, validated at startup by `src/config.ts`
(zod schema). The process exits with a descriptive error before any network call is made if
required variables are missing or malformed.

| Variable | Required | Default | Description |
|---|---|---|---|
| `WHMCS_API_URL` | yes | — | Full URL to your WHMCS installation's API endpoint, e.g. `https://billing.example.com/includes/api.php`. Must be `https://` unless `WHMCS_MCP_ALLOW_INSECURE=1` is also set (local/dev only). |
| `WHMCS_API_IDENTIFIER` | yes | — | The API Identifier for an API Credential created under **Setup > Staff Management > API Credentials** (WHMCS 8.x/9.x). Never the admin username. |
| `WHMCS_API_SECRET` | yes | — | The matching API Secret for the identifier above. Treat as a password; never commit it. Held in a non-enumerable config property and never logged. |
| `WHMCS_API_ACCESS_KEY` | no | unset | Optional per-request `accesskey` value, used as a second factor alongside (or instead of) IP allowlisting on the API Role. See §3. |
| `WHMCS_MCP_MODE` | no | `readonly` | One of `readonly` \| `write` \| `full`. Governs which tool tiers are advertised. See §4. |
| `WHMCS_MCP_ENABLE_DOMAINS` | no | all domains | Comma-separated allowlist of domains to expose, e.g. `tickets,clients,domains`. Valid domains: `system, tickets, clients, products, invoices, domains, orders`. Omit to expose every domain permitted by `WHMCS_MCP_MODE`. |
| `WHMCS_MCP_REDACT_PII` | no | `1` (on) | When `1`/`true`, strips or masks client email/phone/address fields from tool output in addition to the always-on secret/payment redaction. Set to `0` only for trusted, non-shared local debugging. |
| `WHMCS_MCP_TIMEOUT_MS` | no | `15000` | Per-request timeout to the WHMCS API, in milliseconds. |
| `WHMCS_MCP_RATE_LIMIT` | no | `5` | Token-bucket requests-per-second cap enforced by the client before it will issue a new WHMCS API call. |
| `WHMCS_MCP_ALLOW_INSECURE` | no | unset | Set to `1` to permit an `http://` `WHMCS_API_URL` (local sandbox testing only — never for a real WHMCS deployment). |
| `WHMCS_MCP_CONFIRM_TTL_MS` | no | `300000` (5 min) | Lifetime of a confirm-token issued by a billing/destructive tool's preview step before it expires and must be re-requested. |
| `WHMCS_MCP_HTTP` | no | unset | Set to `1` (equivalent to CLI `--http`) to run the Streamable HTTP transport bound to `127.0.0.1` instead of stdio. See `WHMCS_MCP_HTTP_PORT`. |
| `WHMCS_MCP_HTTP_PORT` | no | `8787` | Port for the Streamable HTTP transport when `WHMCS_MCP_HTTP=1`. Always bound to `127.0.0.1`; never `0.0.0.0`. |

A ready-to-copy template lives at [`../.env.example`](../.env.example). It contains only
placeholder values — never real credentials.

---

## 2. Creating a least-privilege WHMCS API Role and Credential

WHMCS's External API (`/includes/api.php`) authenticates with an **API Credential**
(identifier + secret), which is bound to an **API Role** that whitelists specific actions.
This is the same contract on WHMCS 8.12.x and 9.0.x — nothing here changes across that
core upgrade.

1. **Setup > Staff Management > API Roles** → *Create New Role*.
2. Name it for its purpose and deployment, e.g. `mcp-readonly-tickets-clients`.
3. Under **Permissions**, enable only the WHMCS actions this deployment's `WHMCS_MCP_MODE`
   and `WHMCS_MCP_ENABLE_DOMAINS` will actually call. Use the per-tool `whmcsEndpoint`
   column in [`tools.md`](./tools.md) as the checklist. Start from nothing and add actions
   one at a time — do not grant "All Permissions."
   - A `readonly` ticket-triage deployment needs only: `GetTickets`, `GetTicket`,
     `GetTicketNotes`, `GetSupportDepartments`, `GetSupportStatuses`,
     `GetTicketPredefinedReplies`, `GetTicketCounts`, `WhmcsDetails`.
   - Add `AddTicketReply`, `AddTicketNote`, `UpdateTicket` only when moving that
     deployment to `WHMCS_MCP_MODE=write`.
   - Never grant `CreateInvoice`, `UpdateInvoice`, `AddInvoicePayment`, `ApplyCredit`, or
     `CapturePayment` to any role used by an MCP deployment under the 3VS operator policy
     (see §4.3) — those actions ship in the `billing` tier for completeness but must stay
     disabled in that context.
4. **Setup > Staff Management > API Credentials** → *Generate New API Credential*, attach
   the role from step 3, and optionally restrict it to specific source IPs (§3).
5. Copy the generated **Identifier** and **Secret** into `WHMCS_API_IDENTIFIER` /
   `WHMCS_API_SECRET` in your MCP host's environment (Claude Desktop config, Claude Code
   `.mcp.json`, shell profile, or secrets manager) — never into a committed file.
6. Verify with a read-only call before wiring up write/billing tiers: start the server and
   invoke `system_get_details` (backs the `whmcs://system/version` resource); a healthy
   response returns the WHMCS version string and confirms the credential, role, and
   network path all work.

Rotate the secret periodically and immediately if it is ever pasted somewhere it shouldn't
be (chat, a PR, a log). Deleting and recreating the API Credential in WHMCS instantly
revokes the old secret.

---

## 3. IP allowlisting vs. `accesskey`

WHMCS's External API supports two independent access-restriction mechanisms, and you can
use either or both:

- **IP allowlist on the API Credential.** Restrict the credential in
  **Setup > Staff Management > API Credentials** to the specific egress IP(s) the MCP
  server runs from. This is the strongest control when the server has a stable, known
  egress IP (a fixed host, a NAT gateway, a static Docker host IP). It has no corresponding
  environment variable here — it is configured entirely on the WHMCS side.
- **`$api_access_key` (a.k.a. `WHMCS_API_ACCESS_KEY`).** A separate shared secret defined
  under **Setup > General Settings > Security**, sent as the `accesskey` request parameter
  on every External API call. Use this when the server's egress IP is not fixed (a
  container platform with rotating egress, a developer laptop over VPN, a CI runner) or as
  defense in depth alongside an IP allowlist. When set, `whmcs-client.ts` automatically
  includes it on every request; leave `WHMCS_API_ACCESS_KEY` unset to omit it.

Recommended posture for a production 3VS deployment: IP-allowlist the credential to the
MCP host's known egress AND set `WHMCS_API_ACCESS_KEY`. For a laptop-run `readonly` local
session against a WHMCS sandbox, `accesskey` alone is acceptable.

Never put the `accesskey` value in `WHMCS_API_URL` or in client-side/log-visible text — it
is a secret with the same sensitivity as `WHMCS_API_SECRET` and is covered by the same
redaction rules in `src/safety/redact.ts`.

---

## 4. Modes and domains

### 4.1 `WHMCS_MCP_MODE`

Every tool declares a tier: `read`, `write`, `billing`, or `destructive`. `WHMCS_MCP_MODE`
is the master switch deciding which tiers are advertised to the MCP client at all — a tool
outside the enabled tiers for the active mode does not appear in `tools/list`, regardless
of `WHMCS_MCP_ENABLE_DOMAINS`.

| Mode | Tiers advertised | Typical use |
|---|---|---|
| `readonly` (default) | `read` only | Safe default for any new deployment, dashboards, triage assistants, reporting. No WHMCS state can be changed through this server in this mode. |
| `write` | `read`, `write` | Ticket replies/updates, contact/client edits, service/domain field updates, non-financial order actions. Still excludes anything in `billing` or `destructive`. |
| `full` | `read`, `write`, `billing`, `destructive` | Full tool surface, including invoice/quote/order money-moving actions and irreversible deletes/cancellations. Every `billing`/`destructive` tool still requires the two-step confirm-token flow (§5) regardless of mode. |

Even in `full` mode, invoice-mutating tools (`billing_create_invoice`,
`billing_update_invoice`, `billing_add_payment`, `billing_apply_credit`,
`billing_capture_payment`) must remain disabled in any 3VS-operated deployment — see §4.3.

### 4.2 `WHMCS_MCP_ENABLE_DOMAINS`

A secondary, additive filter on top of the mode's tier allowlist. Comma-separated list of:

```
system, tickets, clients, products, invoices, domains, orders
```

Example: a support-desk deployment that should only ever touch tickets and look up client
context, never billing or domains:

```sh
WHMCS_MCP_MODE=write
WHMCS_MCP_ENABLE_DOMAINS=tickets,clients,system
```

Omitting `WHMCS_MCP_ENABLE_DOMAINS` exposes every domain permitted by the active mode.
Combine both variables to size the tool surface precisely to the deployment's job — a
smaller advertised tool list is easier for the API Role to match 1:1 and easier for an
operator to reason about.

### 4.3 Operator policy: invoices are operator-manual

Per standing 3VS operator policy, **no agent writes to WHMCS invoices** — creation,
editing, cancellation, publishing, or attaching a payment method — even under an otherwise
elevated automation mode. Concretely:

- `billing_create_invoice`, `billing_update_invoice`, `billing_add_payment`,
  `billing_apply_credit`, and `billing_capture_payment` ship in the `billing` tier so they
  exist in the codebase and are documented, but **must stay disabled** (i.e.
  `WHMCS_MCP_MODE` must never be `full`) in any 3VS-operated configuration file or runtime
  environment.
- If a workflow genuinely needs invoice data, use the `read` tier tools
  (`billing_list_invoices`, `billing_get_invoice`, `billing_get_transactions`,
  `billing_get_credits`, `billing_get_pay_methods`) — never the mutating ones.
- This restriction is enforced by configuration/deployment discipline, not by a code-level
  hard block, so it must be re-verified whenever a 3VS deployment's `WHMCS_MCP_MODE` is
  changed. See `SECURITY.md` for the full threat model and this policy's rationale.

---

## 5. Confirm-token flow (billing/destructive tools)

Every `billing` and `destructive` tier tool is two-step, independent of `WHMCS_MCP_MODE`:

1. **First call** (no `confirmToken` supplied): the tool validates input, computes and
   returns a human-readable preview of the change plus a short-lived `confirmToken`
   (HMAC-signed, bound to the tool name and argument hash, default TTL 5 minutes /
   `WHMCS_MCP_CONFIRM_TTL_MS`). No WHMCS API call is made yet.
2. **Second call**, echoing the same arguments plus the returned `confirmToken`: the token
   is verified (matching tool, matching argument hash, not expired, not already used) and
   only then does the WHMCS API call execute.

All mutating tools additionally accept `dryRun: true`, which runs input validation and
(for billing/destructive tools) the preview step, but never issues the underlying WHMCS API
call — useful for testing a workflow end-to-end without touching WHMCS.

---

## 6. Per-client install snippets

Replace the placeholder values with your real `WHMCS_API_URL` / `WHMCS_API_IDENTIFIER` /
`WHMCS_API_SECRET` (and `WHMCS_API_ACCESS_KEY` if used) from a secrets manager or local env
file — never commit them.

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "whmcs": {
      "command": "npx",
      "args": ["-y", "@peguesj/whmcs-mcp"],
      "env": {
        "WHMCS_API_URL": "https://billing.example.com/includes/api.php",
        "WHMCS_API_IDENTIFIER": "your-api-identifier",
        "WHMCS_API_SECRET": "your-api-secret",
        "WHMCS_MCP_MODE": "readonly"
      }
    }
  }
}
```

### Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "whmcs": {
      "command": "npx",
      "args": ["-y", "@peguesj/whmcs-mcp"],
      "env": {
        "WHMCS_API_URL": "${WHMCS_API_URL}",
        "WHMCS_API_IDENTIFIER": "${WHMCS_API_IDENTIFIER}",
        "WHMCS_API_SECRET": "${WHMCS_API_SECRET}",
        "WHMCS_MCP_MODE": "readonly",
        "WHMCS_MCP_ENABLE_DOMAINS": "tickets,clients,system"
      }
    }
  }
}
```

Prefer referencing host environment variables (as above) over inlining secrets directly in
a file that might be checked into a repo.

### Cursor (`~/.cursor/mcp.json` or project `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "whmcs": {
      "command": "npx",
      "args": ["-y", "@peguesj/whmcs-mcp"],
      "env": {
        "WHMCS_API_URL": "https://billing.example.com/includes/api.php",
        "WHMCS_API_IDENTIFIER": "your-api-identifier",
        "WHMCS_API_SECRET": "your-api-secret",
        "WHMCS_MCP_MODE": "readonly"
      }
    }
  }
}
```

### Local development (repo checkout, stdio)

```sh
cd utils/whmcs-mcp
cp .env.example .env   # then fill in real values in .env, never commit it
npm install
npm run build
node --env-file=.env dist/index.js
```

### Streamable HTTP transport (local only)

```sh
WHMCS_MCP_HTTP=1 WHMCS_MCP_HTTP_PORT=8787 node --env-file=.env dist/index.js
```

Always leave this bound to `127.0.0.1`; the server does not support binding to `0.0.0.0`
and should not be placed behind a public reverse proxy.

---

## 7. Runtime version awareness

At startup and on demand, the server calls `WhmcsDetails` (exposed as the `system_get_details`
tool and the `whmcs://system/version` resource) to discover the connected instance's actual
WHMCS version. A warning is logged (to stderr — stdout is reserved for MCP stdio traffic) if
the detected version is below `8.0`. See
[`version-compatibility.md`](./version-compatibility.md) for what is and is not verified
against WHMCS 8.12.x vs. 9.0.x specifically.
