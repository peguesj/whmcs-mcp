/**
 * Synthetic WHMCS API fixtures, keyed by WHMCS External API `action` name.
 *
 * ALL data in these files is fabricated for testing (test/mock-whmcs-server.ts),
 * MCP Inspector screenshot capture (scripts/capture-screenshots.ts), and unit
 * tests (test/*.test.ts). No fixture file in this directory may ever contain
 * real client, billing, credential, or PII data — fields that would normally
 * hold sensitive values (passwords, card numbers, CVV, EPP codes, WHOIS
 * registrant PII, etc.) are set to the literal string "[redacted]" or a
 * placeholder consistent with the redaction rules in src/safety/redact.ts.
 *
 * One JSON file per tool domain (mirroring src/tools/<domain>.ts), each
 * mapping a WHMCS `action` name to the JSON body the mock server returns for
 * a successful call to that action. Merge order below matches domain file
 * layout; a name collision across files is a fixture-authoring bug, not
 * expected behavior, and later files intentionally win.
 */
import system from "./system.json" with { type: "json" };
import tickets from "./tickets.json" with { type: "json" };
import clients from "./clients.json" with { type: "json" };
import products from "./products.json" with { type: "json" };
import invoices from "./invoices.json" with { type: "json" };
import domains from "./domains.json" with { type: "json" };
import orders from "./orders.json" with { type: "json" };

export type WhmcsAction = string;

/** A single fixture WHMCS API JSON response body, always including `result`. */
export type WhmcsFixtureResponse = Record<string, unknown> & {
  result: "success" | "error";
};

/**
 * The bundled allowlist of every documented action this fixture set knows
 * about. Mirrors the `whmcs_raw_call` allowlist in src/schemas/system.ts;
 * kept here too so test/mock-whmcs-server.ts and scripts/gen-docs.ts can
 * validate coverage without importing the source tree's schema module.
 */
export const RAW_CALL_ALLOWLIST: readonly string[] = (
  system as { RawAllowlist: string[] }
).RawAllowlist;

/**
 * All fixtures merged into a single action -> response map. `RawAllowlist`
 * is a metadata array, not a response, and is intentionally excluded here.
 */
export const fixtures: Record<string, WhmcsFixtureResponse> = {
  ...(stripMeta(system) as Record<string, WhmcsFixtureResponse>),
  ...(tickets as Record<string, WhmcsFixtureResponse>),
  ...(clients as Record<string, WhmcsFixtureResponse>),
  ...(products as Record<string, WhmcsFixtureResponse>),
  ...(invoices as Record<string, WhmcsFixtureResponse>),
  ...(domains as Record<string, WhmcsFixtureResponse>),
  ...(orders as Record<string, WhmcsFixtureResponse>),
};

function stripMeta(mod: Record<string, unknown>): Record<string, unknown> {
  const { RawAllowlist: _unused, ...rest } = mod;
  return rest;
}

/**
 * Looks up the fixture response for a given WHMCS `action`. Returns a
 * generic `result: "error"` body (mirroring WHMCS's own shape for an
 * unrecognized action) rather than throwing, so the mock server can always
 * produce a well-formed HTTP response.
 */
export function getFixture(action: string): WhmcsFixtureResponse {
  const fixture = fixtures[action];
  if (fixture) {
    return fixture;
  }
  return {
    result: "error",
    message: `Fixture not implemented for action "${action}"`,
  };
}

export default fixtures;
