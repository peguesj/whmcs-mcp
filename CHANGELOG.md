# Changelog

All notable changes to `@peguesj/whmcs-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- Streamable HTTP transport hardening (loopback-only bind verification in CI)
- Additional MCP prompts for renewal/dunning workflows
- Optional SQLite cache for `whmcs://system/version` to reduce redundant `WhmcsDetails` calls

## [0.1.0] - 2026-09-28

Initial public release.

### Added
- MCP server (`src/index.ts`) over stdio by default, with an opt-in Streamable
  HTTP transport bound to `127.0.0.1` via `--http`.
- Typed WHMCS External API client (`src/whmcs-client.ts`): form-encoded POST to
  `{WHMCS_API_URL}/includes/api.php`, `identifier`/`secret`/optional
  `accesskey` auth, token-bucket rate limiting, retry-on-read backoff for
  5xx/429, request timeout, `WhmcsApiError` mapping of `result=error`
  responses, and normalization of WHMCS's nested collection shapes
  (e.g. `{tickets:{ticket:[...]}}`) into plain arrays. No request or response
  body is ever logged.
- Domain-scoped tool modules under `src/tools/`: `system`, `tickets`,
  `clients`, `products` (services/addons), `invoices` (billing + quotes),
  `domains`, and `orders`, plus the `whmcs_raw_call` escape hatch (full mode
  only, allowlisted actions).
- Tiered safety model (`src/safety/policy.ts`): every tool is `read`, `write`,
  `billing`, or `destructive`. `WHMCS_MCP_MODE` (`readonly` default, `write`,
  `full`) and `WHMCS_MCP_ENABLE_DOMAINS` gate which tools are advertised.
- Two-step confirmation flow (`src/safety/confirm.ts`) for `billing` and
  `destructive` tools: a preview call returns a short-lived, single-use,
  HMAC-signed `confirmToken` that must be echoed back to execute. All
  mutating tools additionally accept `dryRun`.
- Deep redaction layer (`src/safety/redact.ts`) applied to tool results and
  error messages: strips API secrets, passwords, card/bank/paymethod data,
  CVV, and EPP codes; optionally redacts email/phone/address via
  `WHMCS_MCP_REDACT_PII`.
- Runtime version detection: `system_get_details` tool and the
  `whmcs://system/version` resource call `WhmcsDetails`; a warning is logged
  for any reported version below 8.0. Verified against the 8.12.x and 9.0.x
  External API contract.
- MCP resources: `whmcs://system/version`, `whmcs://support/departments`,
  `whmcs://support/statuses`, `whmcs://billing/payment-methods`,
  `whmcs://orders/statuses`.
- MCP prompts: `triage-ticket`, `client-360`, `overdue-invoice-review`.
- `billing_create_invoice`, `billing_update_invoice`, `billing_add_payment`,
  `billing_apply_credit`, and `billing_capture_payment` ship in the `billing`
  tier, disabled unless `WHMCS_MCP_MODE=full`, per the operator policy that
  invoices are operator-manual. Documented in `SECURITY.md` and `README.md`;
  must stay disabled in any 3VS deployment configuration.
- Synthetic mock WHMCS HTTP server (`test/mock-whmcs-server.ts`) and fixtures
  for contract tests and for the screenshot-capture pipeline; no real WHMCS
  instance or client data is used or published.
- Marketing site (`site/index.html`) generated in part from the tool
  registry's Zod schemas, deployed via GitHub Pages (`.github/workflows/pages.yml`).
- CI (`ci.yml`): typecheck, lint, test, generated-docs drift check, and
  `npm pack --dry-run` on a Node 20/22 matrix. Release workflow
  (`release.yml`) publishes to npm with provenance on tag push.
- `Dockerfile` (distroless Node runtime, non-root) and `server.json` MCP
  registry manifest.
- MIT license.

### Security
- Read-only by default (`WHMCS_MCP_MODE=readonly`); write, billing, and
  destructive tiers are opt-in and layered behind explicit mode and
  confirmation-token gates.
- No credentials, secrets, or request/response bodies are ever written to
  logs (stdout is reserved for MCP stdio framing; all logging goes to
  stderr through `src/logger.ts`, post-redaction).
- Screenshots for the public marketing site are captured only against the
  in-repo mock WHMCS server with synthetic fixture data, never a live
  WHMCS instance.

[Unreleased]: https://github.com/peguesj/whmcs-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/peguesj/whmcs-mcp/releases/tag/v0.1.0
