# Screenshots

This directory holds the PNG screenshots embedded on the marketing site
(`site/index.html`). They are **generated artifacts**, not hand-authored
files, and are produced by:

```sh
npx tsx scripts/capture-screenshots.ts
```

That script starts `test/mock-whmcs-server.ts` (synthetic fixture data only —
no real WHMCS instance, no client PII, per project policy) alongside the
`@modelcontextprotocol/inspector`, drives it with Playwright, and writes the
following files here:

| File | Captures |
|---|---|
| `tool-catalog.png` | Inspector's tool list, grouped by domain, showing tier badges (read/write/billing/destructive) |
| `ticket-triage.png` | The `triage-ticket` prompt walking a synthetic support ticket end to end |
| `client-360.png` | The `client-360` prompt assembling a client/services/invoices view from mock data |
| `confirm-gate.png` | The two-step confirm flow: a billing-tier tool call returning a `confirmToken` preview, then the confirmed mutation |
| `version-detection.png` | `system_get_details` / `whmcs://system/version` resource showing runtime WHMCS version discovery |

Do not commit screenshots captured against a real WHMCS instance. CI
(`ci.yml`) regenerates and diffs these on release branches; treat local
copies as disposable build output between runs.
