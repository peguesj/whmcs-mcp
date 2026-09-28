/**
 * src/tools/custom.ts
 *
 * Extensibility layer: lets an operator register additional MCP tools that
 * call WHMCS API actions this package doesn't ship a built-in tool for —
 * most commonly custom actions exposed by a third-party or in-house WHMCS
 * addon module (registered via that module's own `include/hooks.php`
 * `APIRegister`-style hook, which maps an arbitrary action name to addon
 * logic and returns it through the same External API surface as any core
 * action). This package never hardcodes any specific addon's action names —
 * an operator supplies their own manifest describing what they need exposed.
 *
 * Manifest format (JSON), one file per deployment, pointed to by
 * WHMCS_MCP_CUSTOM_TOOLS_FILE:
 *
 *   [
 *     {
 *       "name": "myaddon_get_widget_status",
 *       "domain": "custom",
 *       "tier": "read",
 *       "whmcsAction": "MyAddonGetWidgetStatus",
 *       "description": "Get widget status from the MyAddon module.",
 *       "params": {
 *         "widgetId": { "type": "string", "required": true },
 *         "verbose": { "type": "boolean", "required": false }
 *       }
 *     }
 *   ]
 *
 * `params` describes a flat, single-level parameter set (matching how the
 * WHMCS External API itself takes flat form-encoded parameters — there is
 * no nested-object convention to preserve here). Supported `type` values:
 * "string" | "number" | "boolean" | "string[]". Anything else is treated as
 * an opaque JSON-stringified value passed through verbatim, since a custom
 * addon action's real parameter contract is only known to its author.
 *
 * This is intentionally a thin, generic escape hatch rather than a typed
 * per-action schema like the built-in domains: a custom addon's contract is
 * unknown to this package by definition, so tools registered this way trade
 * strict typing for the ability to reach arbitrary custom actions without
 * forking the server. Prefer contributing a real typed domain module
 * upstream once an action is stable and widely useful.
 */

import { readFileSync } from "node:fs";

import { z } from "zod";

import {
  defineTool,
  type ToolDomain,
  type ToolTier,
  type ConfirmableInput,
} from "./registry.js";

/** Minimal context this module needs; kept local to avoid coupling to index.ts. */
export interface CustomToolsContext {
  logger?: { info?: (message: string) => void };
}

interface CustomParamSpec {
  type?: "string" | "number" | "boolean" | "string[]" | (string & {});
  required?: boolean;
  description?: string;
}

/** Input shape for a dynamically-declared custom tool: the safety fields plus whatever flat params the manifest declares. */
type CustomToolInput = ConfirmableInput & Record<string, unknown>;

interface CustomToolSpec {
  name: string;
  domain?: string;
  tier: ToolTier;
  whmcsAction: string;
  description: string;
  params?: Record<string, CustomParamSpec>;
}

function paramSchema(spec: CustomParamSpec): z.ZodType {
  let base: z.ZodType;
  switch (spec.type) {
    case "number":
      base = z.number();
      break;
    case "boolean":
      base = z.boolean();
      break;
    case "string[]":
      base = z.array(z.string());
      break;
    case "string":
    case undefined:
      base = z.string();
      break;
    default:
      // Unknown declared type: accept anything and let the operator's own
      // addon action validate it server-side.
      base = z.unknown();
  }
  if (spec.description) {
    base = base.describe(spec.description);
  }
  return spec.required ? base : base.optional();
}

function buildInputSchema(spec: CustomToolSpec): z.ZodType {
  const shape: Record<string, z.ZodType> = {
    dryRun: z.boolean().optional().describe("Preview only; makes no WHMCS API call."),
    confirmToken: z.string().optional(),
  };
  for (const [key, paramSpec] of Object.entries(spec.params ?? {})) {
    shape[key] = paramSchema(paramSpec);
  }
  return z.object(shape);
}

/**
 * Loads and registers every tool described in WHMCS_MCP_CUSTOM_TOOLS_FILE, if
 * set. Silently does nothing if the env var is unset. Throws (fails startup
 * loudly) if the file is set but unreadable or malformed — a broken custom
 * manifest should never fail open into "just don't have those tools".
 */
export function registerCustomTools(ctx: CustomToolsContext): void {
  const manifestPath = process.env.WHMCS_MCP_CUSTOM_TOOLS_FILE;
  if (!manifestPath) return;

  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    throw new Error(
      `whmcs-mcp: WHMCS_MCP_CUSTOM_TOOLS_FILE is set to "${manifestPath}" but could not be read: ${
        (err as Error).message
      }`,
    );
  }

  let specs: CustomToolSpec[];
  try {
    specs = JSON.parse(raw) as CustomToolSpec[];
  } catch (err) {
    throw new Error(
      `whmcs-mcp: WHMCS_MCP_CUSTOM_TOOLS_FILE ("${manifestPath}") is not valid JSON: ${
        (err as Error).message
      }`,
    );
  }

  if (!Array.isArray(specs)) {
    throw new Error(
      `whmcs-mcp: WHMCS_MCP_CUSTOM_TOOLS_FILE ("${manifestPath}") must be a JSON array of tool specs.`,
    );
  }

  const VALID_TIERS: readonly ToolTier[] = ["read", "write", "billing", "destructive"];

  for (const spec of specs) {
    if (
      !spec.name ||
      spec.name.length === 0 ||
      !spec.whmcsAction ||
      spec.whmcsAction.length === 0 ||
      !VALID_TIERS.includes(spec.tier) ||
      !spec.description ||
      spec.description.length === 0
    ) {
      throw new Error(
        `whmcs-mcp: custom tool spec missing required field(s) (name, whmcsAction, tier, description): ${JSON.stringify(
          spec,
        )}`,
      );
    }

    const inputSchema = buildInputSchema(spec) as unknown as z.ZodType<CustomToolInput>;

    defineTool<CustomToolInput>({
      name: spec.name,
      domain: (spec.domain ?? "custom") as ToolDomain,
      tier: spec.tier,
      whmcsAction: spec.whmcsAction,
      description: spec.description,
      inputSchema,
      annotations: {
        title: spec.name,
        readOnlyHint: spec.tier === "read",
        destructiveHint: spec.tier === "destructive",
        idempotentHint: spec.tier === "read",
      },
      handler: async (input, toolCtx) => {
        const { dryRun: _dryRun, confirmToken: _confirmToken, ...params } = input as unknown as Record<
          string,
          unknown
        >;
        const result = await toolCtx.whmcs.call(spec.whmcsAction, params);
        return {
          data: result,
          summary: `${spec.name} completed.`,
        };
      },
    });
  }

  ctx.logger?.info?.(
    `whmcs-mcp: registered ${String(specs.length)} custom tool(s) from ${manifestPath}`,
  );
}
