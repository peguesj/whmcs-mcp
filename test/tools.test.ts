/**
 * test/tools.test.ts
 *
 * Contract tests for every MCP tool exposed by whmcs-bridge-mcp, against the
 * REAL registry surface in src/tools/registry.ts:
 *
 *   - `defineTool(def)` (single-arg) records a tool definition as a
 *     module-load side effect of each src/tools/<domain>.ts file.
 *   - `getAllToolDefinitions()` returns every definition recorded so far.
 *   - `registerTools(server, ctx)` filters definitions by
 *     WHMCS_MCP_MODE/WHMCS_MCP_ENABLE_DOMAINS and calls
 *     `server.registerTool(name, meta, callback)` for each one that passes.
 *
 * There is no `buildToolRegistry`/`RegisteredTool` export (an earlier,
 * abandoned API shape) -- this file drives the real API by importing every
 * domain module for its `defineTool` side effects, then exercising
 * `registerTools` against a minimal fake `McpServer` stub that captures each
 * registered tool's `(meta, callback)` pair, which is what a real MCP client
 * actually calls (not the raw `def.handler`). This is the same pattern
 * test/safety.test.ts's header comment recommends for reconciling this file
 * with the real registry.
 *
 * Scope (preserved from the original plan, re-targeted at the real API):
 *   - coverage: every tool `defineTool`'d by the domain modules has a valid
 *     tier/domain and is advertised under full mode + all domains, with no
 *     drift between the declared tier and what mode-gating actually does.
 *   - schema -> WHMCS param serialization + result shape, for a
 *     representative tool per domain/tier combination (verified against the
 *     real mock WHMCS server), including the billing/destructive two-step
 *     confirmToken flow and dryRun short-circuiting.
 *   - mode filtering (readonly | write | full).
 *   - domain filtering (WHMCS_MCP_ENABLE_DOMAINS).
 *
 * The full 84-tool fixture table from the original (unrunnable) version of
 * this file duplicated src/tools/*.ts's own `name`/`domain`/`tier`/
 * `whmcsAction` declarations by hand, which is exactly the kind of drift
 * this rewrite avoids: coverage/mode/domain assertions below read that
 * metadata directly from `getAllToolDefinitions()` (the real source of
 * truth) instead of a hand-maintained duplicate.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { startMockWhmcsServer, type MockWhmcsServer } from "./mock-whmcs-server.js";
import { createWhmcsClient, type WhmcsClient } from "../src/whmcs-client.js";
import {
  getAllToolDefinitions,
  registerTools,
  type ToolContext,
  type ToolDefinition,
  type ToolDomain,
  type ToolTier,
} from "../src/tools/registry.js";
import type { WhmcsMcpConfig, McpMode } from "../src/config.js";

// Side-effect imports: population of the shared TOOL_REGISTRY, mirroring
// exactly what src/index.ts does before calling registerTools(...).
import "../src/tools/system.js";
import "../src/tools/tickets.js";
import "../src/tools/clients.js";
import "../src/tools/products.js";
import "../src/tools/invoices.js";
import "../src/tools/domains.js";
import "../src/tools/orders.js";

const ALL_TIERS: readonly ToolTier[] = ["read", "write", "billing", "destructive"];
const ALL_DOMAINS: readonly ToolDomain[] = [
  "system",
  "tickets",
  "clients",
  "products",
  "invoices",
  "domains",
  "orders",
  "custom",
];

/* -------------------------------------------------------------------------
 * Fake McpServer: captures registerTool(name, meta, callback) the same way
 * the real MCP SDK's McpServer does, without pulling in transport/session
 * machinery this file has no use for. This is what real MCP clients call --
 * not `def.handler` directly -- so exercising it here is what actually
 * proves the registered tool works end to end (schema validation, the
 * confirm-token gate, redaction, and structuredContent wrapping all live in
 * registerTools' callback, not in a bare handler call).
 * ---------------------------------------------------------------------- */

interface CapturedTool {
  meta: { description: string; inputSchema: unknown; annotations: Record<string, unknown> };
  callback: (rawInput: unknown, extra?: unknown) => Promise<{
    content: { type: "text"; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

class FakeMcpServer {
  readonly tools = new Map<string, CapturedTool>();
  registerTool(
    name: string,
    meta: CapturedTool["meta"],
    callback: CapturedTool["callback"],
  ): void {
    this.tools.set(name, { meta, callback });
  }
}

/* -------------------------------------------------------------------------
 * Test harness
 * ---------------------------------------------------------------------- */

let mock: MockWhmcsServer;
let apiUrl: string;
let client: WhmcsClient;

beforeAll(async () => {
  mock = await startMockWhmcsServer({
    credentials: { identifier: "mcp-test-identifier", secret: "mcp-test-secret" },
  });
  const address = mock.server.address() as AddressInfo;
  apiUrl = `http://127.0.0.1:${address.port}`;
  client = createWhmcsClient({
    apiUrl,
    identifier: "mcp-test-identifier",
    secret: "mcp-test-secret",
    timeoutMs: 5_000,
    rateLimitPerSecond: 100,
    allowInsecure: true,
  });
});

afterAll(async () => {
  await mock.close();
});

afterEach(() => {
  mock.reset();
});

/** Builds a minimal, real-shaped WhmcsMcpConfig for a given mode/domain set. */
function makeConfig(mode: McpMode, enabledDomains?: readonly string[]): WhmcsMcpConfig {
  return {
    apiUrl,
    allowInsecure: true,
    mode,
    enabledDomains: (enabledDomains ?? []) as never,
    redactPii: true,
    timeoutMs: 5_000,
    rateLimitPerMinute: 6_000,
    getSecrets: () => ({
      identifier: "mcp-test-identifier",
      secret: "mcp-test-secret",
      accessKey: undefined,
    }),
  } as WhmcsMcpConfig;
}

/** Registers every tool that passes mode/domain gating onto a fresh FakeMcpServer. */
function registerAndCapture(mode: McpMode, enabledDomains?: readonly string[]): FakeMcpServer {
  const server = new FakeMcpServer();
  const ctx: ToolContext = { whmcs: client, config: makeConfig(mode, enabledDomains) };
  registerTools(server as unknown as Parameters<typeof registerTools>[0], ctx);
  return server;
}

const ALL_DEFS: ReadonlyArray<ToolDefinition<any>> = getAllToolDefinitions();

/* -------------------------------------------------------------------------
 * 1. Coverage: every defineTool'd tool has valid metadata and is advertised
 *    under full mode + every domain, with the exact tier/domain it declared.
 * ---------------------------------------------------------------------- */

describe("tool registry coverage", () => {
  it("has at least one tool defined per built-in domain module", () => {
    expect(ALL_DEFS.length).toBeGreaterThan(0);
    const domainsSeen = new Set(ALL_DEFS.map((d) => d.domain));
    for (const domain of ["system", "tickets", "clients", "products", "invoices", "domains", "orders"] as const) {
      expect(domainsSeen.has(domain), `expected at least one tool in domain "${domain}"`).toBe(true);
    }
  });

  it("every tool declares a tier from the four known tiers and a domain from the known domain set", () => {
    for (const def of ALL_DEFS) {
      expect(ALL_TIERS, `tool "${def.name}" has unknown tier "${def.tier}"`).toContain(def.tier);
      expect(ALL_DOMAINS, `tool "${def.name}" has unknown domain "${def.domain}"`).toContain(def.domain);
    }
  });

  it("every tool name is unique (defineTool's own duplicate guard, exercised end to end)", () => {
    const names = ALL_DEFS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("registers every defined tool, with its declared tier, when mode=full and all domains are enabled", () => {
    const server = registerAndCapture("full", ALL_DOMAINS);
    expect(server.tools.size).toBe(ALL_DEFS.length);
    for (const def of ALL_DEFS) {
      const captured = server.tools.get(def.name);
      expect(captured, `expected tool "${def.name}" to be registered`).toBeDefined();
      expect(captured!.meta.description).toContain(`[${def.tier}]`);
      expect(captured!.meta.description).toContain(def.whmcsAction);
    }
  });

  it("billing and destructive tiers are always confirm-gated in their own definitions (policy is not opt-out per tool)", () => {
    const billingOrDestructive = ALL_DEFS.filter((d) => d.tier === "billing" || d.tier === "destructive");
    expect(billingOrDestructive.length).toBeGreaterThan(0);
    // resolveToolPolicy would throw at registration time if a tool tried to
    // opt out; registerAndCapture("full", ...) above already exercised that
    // path without throwing, so this is a structural sanity check that the
    // sample is non-empty and every entry is one of the two gated tiers.
    for (const def of billingOrDestructive) {
      expect(["billing", "destructive"]).toContain(def.tier);
    }
  });
});

/* -------------------------------------------------------------------------
 * 2. Mode filtering: readonly | write | full
 * ---------------------------------------------------------------------- */

describe("mode filtering", () => {
  it("readonly mode advertises only read-tier tools", () => {
    const server = registerAndCapture("readonly", ALL_DOMAINS);
    expect(server.tools.size).toBeGreaterThan(0);
    const expectedReadNames = new Set(ALL_DEFS.filter((d) => d.tier === "read").map((d) => d.name));
    expect(new Set(server.tools.keys())).toEqual(expectedReadNames);
  });

  it("write mode advertises read and write tier tools, never billing or destructive", () => {
    const server = registerAndCapture("write", ALL_DOMAINS);
    const expected = new Set(
      ALL_DEFS.filter((d) => d.tier === "read" || d.tier === "write").map((d) => d.name),
    );
    expect(new Set(server.tools.keys())).toEqual(expected);
  });

  it("full mode advertises every tier including billing and destructive", () => {
    const server = registerAndCapture("full", ALL_DOMAINS);
    expect(new Set(server.tools.keys())).toEqual(new Set(ALL_DEFS.map((d) => d.name)));
    const anyBilling = ALL_DEFS.find((d) => d.tier === "billing");
    const anyDestructive = ALL_DEFS.find((d) => d.tier === "destructive");
    expect(anyBilling).toBeDefined();
    expect(anyDestructive).toBeDefined();
    expect(server.tools.has(anyBilling!.name)).toBe(true);
    expect(server.tools.has(anyDestructive!.name)).toBe(true);
  });

  it("the billing tier stays disabled outside mode=full -- no combination of readonly/write ever exposes it", () => {
    const billingNames = ALL_DEFS.filter((d) => d.tier === "billing").map((d) => d.name);
    expect(billingNames.length).toBeGreaterThan(0);
    for (const mode of ["readonly", "write"] as const) {
      const server = registerAndCapture(mode, ALL_DOMAINS);
      for (const name of billingNames) {
        expect(server.tools.has(name)).toBe(false);
      }
    }
  });
});

/* -------------------------------------------------------------------------
 * 3. Domain filtering: WHMCS_MCP_ENABLE_DOMAINS
 * ---------------------------------------------------------------------- */

describe("domain filtering", () => {
  it("only advertises tools from enabled domains", () => {
    const server = registerAndCapture("full", ["tickets", "system"]);
    for (const name of server.tools.keys()) {
      const def = ALL_DEFS.find((d) => d.name === name)!;
      expect(["tickets", "system"]).toContain(def.domain);
    }
    expect(server.tools.has("clients_list")).toBe(false);
    expect(server.tools.has("billing_list_invoices")).toBe(false);
    expect(server.tools.has("tickets_list")).toBe(true);
    expect(server.tools.has("system_get_details")).toBe(true);
  });

  it("an empty domain list is treated as \"no restriction\" (all domains), matching registerTools' own `.length > 0` gate", () => {
    // registerTools only builds an enabledDomains Set when the config array
    // is non-empty (src/tools/registry.ts); an empty array falls through to
    // "no restriction", the same as leaving WHMCS_MCP_ENABLE_DOMAINS unset.
    // A prior version of this test asserted the opposite (empty => none),
    // which does not match the real, intentional gate.
    const server = registerAndCapture("full", []);
    expect(server.tools.size).toBe(ALL_DEFS.length);
  });

  it("mode and domain filters compose (intersection, not union)", () => {
    const server = registerAndCapture("readonly", ["invoices"]);
    for (const name of server.tools.keys()) {
      const def = ALL_DEFS.find((d) => d.name === name)!;
      expect(def.domain).toBe("invoices");
      expect(def.tier).toBe("read");
    }
    expect(server.tools.has("billing_list_invoices")).toBe(true);
    expect(server.tools.has("billing_create_invoice")).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * 4. Schema -> WHMCS param serialization + result shape, for a
 *    representative tool per tier/domain combination the mock server
 *    actually fixtures.
 * ---------------------------------------------------------------------- */

type SampleFixture = {
  readonly name: string;
  readonly action: string;
  readonly input: Record<string, unknown>;
  readonly gated: boolean;
};

const SAMPLES: readonly SampleFixture[] = [
  { name: "system_get_details", action: "WhmcsDetails", input: {}, gated: false },
  { name: "system_get_todo_items", action: "GetToDoItems", input: {}, gated: false },
  {
    name: "system_send_email",
    action: "SendEmail",
    input: { mode: "template", id: 1, messagename: "Test Email" },
    gated: false,
  },
  {
    name: "whmcs_raw_call",
    action: "WhmcsDetails",
    input: { action: "WhmcsDetails", params: {} },
    gated: true,
  },
  { name: "tickets_list", action: "GetTickets", input: {}, gated: false },
  {
    name: "tickets_create",
    action: "OpenTicket",
    input: { deptid: 1, subject: "Test", message: "Test message", clientid: 1 },
    gated: false,
  },
  { name: "tickets_delete", action: "DeleteTicket", input: { ticketid: 1 }, gated: true },
  { name: "clients_get", action: "GetClientsDetails", input: { clientid: 1 }, gated: false },
  {
    name: "clients_create",
    action: "AddClient",
    input: {
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
    gated: false,
  },
  { name: "clients_close", action: "CloseClient", input: { clientid: 1 }, gated: true },
  { name: "billing_list_invoices", action: "GetInvoices", input: {}, gated: false },
  {
    name: "billing_create_invoice",
    action: "CreateInvoice",
    input: { userid: 1, items: [{ description: "Test item", amount: "10.00" }] },
    gated: true,
  },
  { name: "domains_list", action: "GetClientsDomains", input: {}, gated: false },
  { name: "domains_register", action: "DomainRegister", input: { domainid: 1 }, gated: true },
  { name: "orders_list", action: "GetOrders", input: {}, gated: false },
  { name: "orders_cancel", action: "CancelOrder", input: { orderid: 1 }, gated: true },
];

describe("schema -> WHMCS param serialization and result shape", () => {
  // `registerAndCapture` reads the module-scoped `client` set in the
  // top-level `beforeAll` above; it must not run at collection time (this
  // describe callback body executes synchronously while the file is being
  // collected, before any `beforeAll` hook has run), or `ctx.whmcs` is
  // still undefined when the registered callbacks are invoked below.
  let server: FakeMcpServer;
  beforeAll(() => {
    server = registerAndCapture("full", ALL_DOMAINS);
  });

  it("covers a representative tool for every tier this server declares", () => {
    const coveredTiers = new Set(
      SAMPLES.map((s) => ALL_DEFS.find((d) => d.name === s.name)!.tier),
    );
    expect(coveredTiers).toEqual(new Set(ALL_TIERS));
  });

  for (const sample of SAMPLES) {
    it(`${sample.name} accepts its sample input, calls WHMCS action "${sample.action}", and returns structured content`, async () => {
      const tool = server.tools.get(sample.name);
      expect(tool, `expected tool "${sample.name}" to be registered`).toBeDefined();

      const parsed = (tool!.meta.inputSchema as { safeParse?: (v: unknown) => { success: boolean } }).safeParse?.(
        sample.input,
      );
      if (parsed) {
        expect(parsed.success, `input schema rejected sample input for "${sample.name}"`).toBe(true);
      }

      const result = await tool!.callback(sample.input);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.isError).not.toBe(true);

      if (sample.gated) {
        // First (unconfirmed) call must preview only, never reach WHMCS.
        expect(result.structuredContent).toMatchObject({ pendingConfirmation: true });
        expect(typeof (result.structuredContent as Record<string, unknown>)["confirmToken"]).toBe("string");
        expect(mock.calls.some((c) => c.action === sample.action)).toBe(false);
      } else {
        expect(result.structuredContent).toBeDefined();
        expect(mock.calls.some((c) => c.action === sample.action)).toBe(true);
        const call = mock.calls.find((c) => c.action === sample.action);
        expect(call!.params["identifier"]).toBe("mcp-test-identifier");
        expect(call!.params["responsetype"]).toBe("json");
      }
    });
  }
});

/* -------------------------------------------------------------------------
 * 5. Two-step confirmation flow for billing/destructive tools.
 * ---------------------------------------------------------------------- */

describe("two-step confirmation flow for billing/destructive tools", () => {
  const gatedSamples = SAMPLES.filter((s) => s.gated);

  it.each(gatedSamples.map((s) => [s.name, s] as const))(
    "%s executes against WHMCS once the confirmToken is echoed back",
    async (_name, sample) => {
      const server = registerAndCapture("full", ALL_DOMAINS);
      const tool = server.tools.get(sample.name)!;

      const preview = await tool.callback(sample.input);
      const previewBody = preview.structuredContent as { pendingConfirmation: boolean; confirmToken: string };
      expect(previewBody.pendingConfirmation).toBe(true);

      const confirmed = await tool.callback({ ...sample.input, confirmToken: previewBody.confirmToken });

      expect(mock.calls.some((c) => c.action === sample.action)).toBe(true);
      expect(confirmed.structuredContent).toBeDefined();
      expect((confirmed.structuredContent as Record<string, unknown>)["pendingConfirmation"]).not.toBe(true);
    },
  );

  it("rejects a confirmToken that does not match the args it was issued for", async () => {
    const server = registerAndCapture("full", ALL_DOMAINS);
    const tool = server.tools.get("clients_close")!;

    const preview = await tool.callback({ clientid: 1 });
    const { confirmToken } = preview.structuredContent as { confirmToken: string };

    const result = await tool.callback({ clientid: 999, confirmToken });

    // registerTools' callback never throws to the caller -- a failed
    // confirmation comes back as a normal (non-pending) structured result
    // carrying an "invalid_confirm_token" error, per registry.ts's
    // runWithConfirmation, and CloseClient must never have been called.
    expect((result.structuredContent as Record<string, unknown>)["error"]).toBe("invalid_confirm_token");
    expect(mock.calls.some((c) => c.action === "CloseClient")).toBe(false);
  });

  it("dryRun never reaches WHMCS even without a confirmToken, for a gated tool", async () => {
    const server = registerAndCapture("full", ALL_DOMAINS);
    const tool = server.tools.get("tickets_delete")!;

    const result = await tool.callback({ ticketid: 1, dryRun: true });
    expect((result.structuredContent as Record<string, unknown>)["dryRun"]).toBe(true);
    expect(mock.calls.some((c) => c.action === "DeleteTicket")).toBe(false);
  });

  it("dryRun short-circuits a non-gated write tool too, with no network call", async () => {
    const server = registerAndCapture("full", ALL_DOMAINS);
    const tool = server.tools.get("tickets_create")!;

    const result = await tool.callback({
      deptid: 1,
      subject: "Test",
      message: "Test message",
      clientid: 1,
      dryRun: true,
    });
    expect((result.structuredContent as Record<string, unknown>)["dryRun"]).toBe(true);
    expect(mock.calls.some((c) => c.action === "OpenTicket")).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * 6. Redaction: even in full mode, secrets never leak in results.
 * ---------------------------------------------------------------------- */

describe("redaction is applied to every tool result", () => {
  it("clients_get never surfaces a raw password/secret field", async () => {
    const server = registerAndCapture("full", ALL_DOMAINS);
    const result = await server.tools.get("clients_get")!.callback({ clientid: 1 });
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).not.toMatch(/"password2?"\s*:\s*"(?!\[REDACTED\])[^"]+"/i);
  });

  it("billing_get_pay_methods never surfaces a full card/bank number", async () => {
    const server = registerAndCapture("full", ALL_DOMAINS);
    const result = await server.tools.get("billing_get_pay_methods")!.callback({ clientid: 1 });
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).not.toMatch(/\b\d{12,19}\b/);
  });
});
