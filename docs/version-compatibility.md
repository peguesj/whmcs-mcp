# WHMCS Version Compatibility

`whmcs-bridge-mcp` targets the WHMCS **External API** (`POST {WHMCS_API_URL}/includes/api.php`,
`identifier`/`secret` auth, `responsetype=json`). This document records what is verified, what is
assumed, and how the server protects itself against an unexpected or unsupported WHMCS version at
runtime.

## Summary

| WHMCS version | Status | Notes |
|---|---|---|
| 9.0.x | **Verified good** (contract-tested) | Local evidence records a production core upgrade from 8.12.1 to 9.0.6 around 2026-08-06/08, logged as "9.0.6 verified good". Treated as the primary current target. |
| 8.12.x | **Verified good** (contract-tested) | Pre-upgrade production baseline. The External API action set, parameter names, and auth scheme used by this server are unchanged between 8.12.x and 9.0.x. |
| 8.0 – 8.11 | Assumed compatible, not directly tested | Same API generation (API Roles, identifier/secret auth introduced in 7.x carried forward unchanged). Every documented action this server calls predates 8.0. |
| < 8.0 | Unsupported / warns at startup | Older auth (`username`/`password` instead of API Credentials) and some response shapes differ. The server does not special-case pre-8.0 behavior. |

This server does **not** silently assume a version. It discovers the live version at startup
(and on demand) via the `WhmcsDetails` action, and logs (stderr, redacted) a warning whenever the
reported version is below `8.0.0`.

## Why the contract is treated as stable across 8.x/9.x

The External API surface consumed here — action names (`GetTickets`, `AddClient`, `GetInvoices`,
`AddOrder`, etc.), the identifier/secret + `responsetype=json` request shape, WHMCS API Roles and
their per-action permission model, and the optional IP allowlist / `$api_access_key` mechanism —
has not changed shape across the 8.x → 9.0.x line per the official API reference
(<https://developers.whmcs.com/api-reference/>). WHMCS 9.0 is a major-version bump driven by PHP
runtime and admin-UI changes, not an External API break. Every tool in this server's registry maps
1:1 to a documented action from that reference, so the typed client and zod schemas are expected to
keep working across both lines without per-version branching.

Local repo evidence for this assessment (read-only, no production access used to produce this
document):

- `.claude/agents/.distill-queue.jsonl` and `.claude/state/backlog-reconcile-20260923/*` record a
  core upgrade from **8.12.1 → 9.0.6** on `web.3vs.io` around 2026-08-06/08, with the line
  `"9.0.6 verified good"`.
- Session memory records production WHMCS moved to the DigitalOcean droplet `68.183.24.135`
  (ssh alias `3vs-plesk`) on 2026-09-15. Any Plesk-hosted copy referenced in older plans may be the
  **diverged Azure rollback copy**, not the live instance — reconfirm the live version (read-only)
  before relying on version assumptions from older documents.

## Runtime version discovery

The server never hardcodes a target version. On startup, and whenever the `system_get_details`
tool or the `whmcs://system/version` resource is invoked, it calls the `WhmcsDetails` action and
reads `whmcs.version` from the response.

- **Tool**: `system_get_details` — no inputs; returns the full `WhmcsDetails` payload
  (with secrets/PII redacted per `src/safety/redact.ts`), including `whmcs.version`.
- **Resource**: `whmcs://system/version` — a lightweight read of just the version string, suitable
  for a client to check compatibility before driving other tools.

Startup behavior:

1. Call `WhmcsDetails`.
2. Parse `whmcs.version` (e.g. `"9.0.6"`).
3. If the parsed major.minor is `< 8.0`, log a **warning** to stderr (never stdout — stdout is
   reserved for MCP stdio framing) noting that the server was built and tested against the 8.x/9.x
   contract and behavior below 8.0 is unverified. The server does not refuse to start; it degrades
   to a warning so read-only diagnostics remain available even against an unexpected instance.
4. If the `WhmcsDetails` call itself fails (auth error, network error, non-JSON response), the
   error is surfaced through the normal `WhmcsApiError` path — this is treated as a connectivity/
   credential problem, not a version problem, and is not swallowed.

### Fallback discovery (read-only, when `WhmcsDetails` is unavailable)

If the API role in use does not permit `WhmcsDetails` for some reason, the same version fact can be
obtained two other read-only ways, documented here for operators rather than implemented as
automatic fallbacks in code (both require access this MCP server does not have — DB or admin UI):

- `SELECT value FROM tblconfiguration WHERE setting = 'Version';` against the WHMCS database.
- The WHMCS admin footer, or **Utilities → System → System Health**, in the browser.

## Tested contract surface

"Tested against 8.12 and 9.0" in this repo means: every tool in `src/tools/*.ts` is exercised in
`test/tools.test.ts` against `test/mock-whmcs-server.ts`, an in-process `node:http` fake of
`/includes/api.php` whose fixtures in `test/fixtures/` mirror the documented 8.x/9.x response
shapes (including WHMCS's nested-collection style, e.g. `{ tickets: { ticket: [...] } }`, which
`src/whmcs-client.ts` normalizes into plain arrays before it reaches a tool handler). This is a
contract test against the documented API surface, not a live integration test against a running
WHMCS instance — no production credentials or PII are used to produce or run these tests, per this
repo's production-boundary and PII rules.

Live re-verification against the current production instance is a separate, explicitly-scoped,
read-only step (see the parent project's operational rules on production boundaries) and is not
performed by CI.

## What would break this assumption

- A future WHMCS major version that renames or removes an External API action used here.
- A future WHMCS version that changes the identifier/secret auth scheme or drops `responsetype=json`
  support.
- An API Role whose permissions do not include an action this server calls — this surfaces as a
  WHMCS `result: "error"` response with a permission-denied message, mapped to `WhmcsApiError`, not
  as a version-compatibility failure.

None of these are silently absorbed: an unrecognized error shape from WHMCS is passed through
(redacted) as a `WhmcsApiError` rather than misreported as success.

## References

- WHMCS API Reference (official): <https://developers.whmcs.com/api-reference/>
- `WhmcsDetails` action: <https://developers.whmcs.com/api-reference/whmcsdetails/>
- Local version evidence: `.claude/agents/.distill-queue.jsonl`,
  `.claude/state/backlog-reconcile-20260923/*` (191919 repo, read-only references, not shipped in
  this public package)
