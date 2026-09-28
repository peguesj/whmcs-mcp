/**
 * test/custom-tools.test.ts
 *
 * End-to-end coverage for src/tools/custom.ts's `registerCustomTools`: the
 * operator-supplied manifest escape hatch that lets a deployment expose
 * additional MCP tools for custom WHMCS addon actions this package does not
 * ship a typed domain module for (see custom.ts's header comment for the
 * manifest format).
 *
 * Coverage:
 *  - A valid manifest (test/fixtures/custom-tools.sample.json) registers the
 *    expected tool name(s) into the shared registry (getAllToolDefinitions),
 *    with the declared domain/tier/whmcsAction, and the resulting tool's
 *    handler round-trips its params to WhmcsClient#call.
 *  - A malformed manifest (missing a required field) throws loudly at
 *    registration time rather than silently registering nothing — per
 *    custom.ts's own "a broken custom manifest should never fail open"
 *    contract.
 *  - No manifest configured (env var unset) is a silent no-op.
 */

import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerCustomTools } from "../src/tools/custom.js";
import { getAllToolDefinitions } from "../src/tools/registry.js";

const SAMPLE_MANIFEST_PATH = join(__dirname, "fixtures", "custom-tools.sample.json");

const ORIGINAL_ENV = process.env["WHMCS_MCP_CUSTOM_TOOLS_FILE"];

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env["WHMCS_MCP_CUSTOM_TOOLS_FILE"];
  } else {
    process.env["WHMCS_MCP_CUSTOM_TOOLS_FILE"] = ORIGINAL_ENV;
  }
});

describe("registerCustomTools", () => {
  it("does nothing when WHMCS_MCP_CUSTOM_TOOLS_FILE is unset", () => {
    delete process.env["WHMCS_MCP_CUSTOM_TOOLS_FILE"];
    const before = getAllToolDefinitions().length;
    registerCustomTools({});
    expect(getAllToolDefinitions().length).toBe(before);
  });

  it("registers every tool declared in a valid manifest, with the manifest's own domain/tier/whmcsAction", () => {
    process.env["WHMCS_MCP_CUSTOM_TOOLS_FILE"] = SAMPLE_MANIFEST_PATH;

    const messages: string[] = [];
    registerCustomTools({ logger: { info: (m) => messages.push(m) } });

    const defs = getAllToolDefinitions();
    const widgetStatus = defs.find((d) => d.name === "myaddon_get_widget_status");
    const widgetReset = defs.find((d) => d.name === "myaddon_reset_widget");

    expect(widgetStatus, "expected myaddon_get_widget_status to be registered").toBeDefined();
    expect(widgetStatus!.domain).toBe("custom");
    expect(widgetStatus!.tier).toBe("read");
    expect(widgetStatus!.whmcsAction).toBe("MyAddonGetWidgetStatus");

    expect(widgetReset, "expected myaddon_reset_widget to be registered").toBeDefined();
    expect(widgetReset!.domain).toBe("custom");
    expect(widgetReset!.tier).toBe("write");
    expect(widgetReset!.whmcsAction).toBe("MyAddonResetWidget");

    // registerCustomTools logs a one-line summary via the injected logger.
    expect(messages.some((m) => m.includes("registered 2 custom tool"))).toBe(true);
  });

  it("a registered custom tool's input schema requires the manifest's required params and accepts the optional ones", () => {
    const defs = getAllToolDefinitions();
    const widgetStatus = defs.find((d) => d.name === "myaddon_get_widget_status")!;

    const missingRequired = widgetStatus.inputSchema.safeParse({});
    expect(missingRequired.success, "widgetId is required and should reject an empty input").toBe(false);

    const valid = widgetStatus.inputSchema.safeParse({ widgetId: "w-1", verbose: true });
    expect(valid.success).toBe(true);
  });

  it("a registered custom tool's handler calls WhmcsClient#call with the manifest's whmcsAction and the caller's flat params", async () => {
    const defs = getAllToolDefinitions();
    const widgetStatus = defs.find((d) => d.name === "myaddon_get_widget_status")!;

    const calls: { action: string; params: unknown }[] = [];
    const fakeWhmcs = {
      call: async (action: string, params: unknown) => {
        calls.push({ action, params });
        return { result: "success", status: "ok" };
      },
    };

    const result = await widgetStatus.handler(
      { widgetId: "w-42", verbose: true } as never,
      { whmcs: fakeWhmcs as never, config: {} as never },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.action).toBe("MyAddonGetWidgetStatus");
    expect(calls[0]!.params).toEqual({ widgetId: "w-42", verbose: true });
    expect(result.data).toEqual({ result: "success", status: "ok" });
  });

  it("throws loudly (never registers anything) when a spec is missing a required field", () => {
    const dir = mkdtempSync(join(tmpdir(), "whmcs-mcp-custom-tools-"));
    const badManifestPath = join(dir, "bad.json");
    try {
      writeFileSync(
        badManifestPath,
        JSON.stringify([
          {
            name: "myaddon_missing_action",
            domain: "custom",
            tier: "read",
            // whmcsAction intentionally omitted -- required field.
            description: "Missing whmcsAction on purpose.",
          },
        ]),
        "utf8",
      );
      process.env["WHMCS_MCP_CUSTOM_TOOLS_FILE"] = badManifestPath;

      const before = getAllToolDefinitions().length;
      expect(() => registerCustomTools({})).toThrow(/missing required field/i);
      // Fail-loud contract: nothing from this manifest (or a partial prefix
      // of it) should have been registered.
      expect(getAllToolDefinitions().length).toBe(before);
      expect(getAllToolDefinitions().some((d) => d.name === "myaddon_missing_action")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws loudly when the manifest file is not valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "whmcs-mcp-custom-tools-"));
    const badManifestPath = join(dir, "not-json.json");
    try {
      writeFileSync(badManifestPath, "{ this is not json", "utf8");
      process.env["WHMCS_MCP_CUSTOM_TOOLS_FILE"] = badManifestPath;

      expect(() => registerCustomTools({})).toThrow(/not valid JSON/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws loudly when the configured manifest file does not exist", () => {
    process.env["WHMCS_MCP_CUSTOM_TOOLS_FILE"] = join(tmpdir(), "whmcs-mcp-custom-tools-does-not-exist.json");
    expect(() => registerCustomTools({})).toThrow(/could not be read/i);
  });
});
