/**
 * src/tools/registry.ts
 *
 * Central `defineTool` helper used by every domain module in src/tools/*.ts.
 *
 * Responsibilities:
 *  - Binds a WHMCS External API action to an MCP tool: name, domain, safety
 *    tier, zod input schema, MCP annotations, and a handler.
 *  - Applies mode/domain filtering so only tools allowed by WHMCS_MCP_MODE
 *    and WHMCS_MCP_ENABLE_DOMAINS are ever registered on the McpServer.
 *  - Implements the two-step confirm-token flow for "billing" and
 *    "destructive" tier tools (preview -> confirmToken -> confirmed call).
 *  - Honors `dryRun` on every mutating tool: no network call is made and a
 *    would-be-sent payload preview is returned instead.
 *  - Runs every result (success or error) through the redaction layer
 *    before it reaches the model, and returns both a structured payload
 *    (`structuredContent`) and a human-readable text summary.
 *
 * This module does not itself know how to call WHMCS — that is
 * src/whmcs-client.ts. It also does not decide the tier policy matrix or the
 * confirm-token cryptography — those live in src/safety/policy.ts and
 * src/safety/confirm.ts respectively. This file wires them together.
 */

import type { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { WhmcsClient, WhmcsApiError } from "../whmcs-client.js";
import type { WhmcsMcpConfig } from "../config.js";
import { redactDeep } from "../safety/redact.js";
import {
  isDomainEnabled,
  isTierAllowedInMode,
  requiresConfirmation,
  type WhmcsMcpMode,
} from "../safety/policy.js";
import {
  createConfirmToken,
  consumeConfirmToken,
  type ConfirmTokenPayload,
} from "../safety/confirm.js";
import { logger } from "../logger.js";

/** Safety tier every registered tool must declare. See safety/policy.ts for the mode matrix this drives. */
export type ToolTier = "read" | "write" | "billing" | "destructive";

/** WHMCS API domain a tool belongs to; mirrors WHMCS_MCP_ENABLE_DOMAINS entries. */
export type ToolDomain =
  | "system"
  | "tickets"
  | "clients"
  | "products"
  | "invoices"
  | "domains"
  | "orders";

/**
 * MCP tool annotations, per the MCP spec's ToolAnnotations shape. These are
 * advisory hints surfaced to the client/model, not enforcement — the actual
 * enforcement is the tier/mode/confirm-token machinery below.
 */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Context passed to every tool handler. Handlers call `whmcs.call(...)` to
 * hit the External API; they never construct the HTTP request themselves.
 */
export interface ToolContext {
  whmcs: WhmcsClient;
  config: WhmcsMcpConfig;
}

/**
 * Result shape every handler returns, before this registry wraps it into
 * the MCP CallToolResult (text + structuredContent) and redacts it.
 */
export interface ToolHandlerResult {
  /** Raw structured data to hand back to the model, pre-redaction. */
  data: unknown;
  /** Optional short human-readable summary line; auto-generated from `data` if omitted. */
  summary?: string;
  /** True if this call was a dry run / preview and made no WHMCS mutation. */
  dryRun?: boolean;
  /** True if this call only returned a confirmation preview, awaiting confirmToken replay. */
  pendingConfirmation?: boolean;
}

/**
 * Fields every tool's zod input schema is expected to be able to carry for
 * write/billing/destructive tiers. Domain schema files (src/schemas/*.ts)
 * should `.extend()` a base object that includes these as optional fields
 * rather than redeclaring them; this registry reads them generically via
 * the parsed input object.
 */
interface ConfirmableInput {
  dryRun?: boolean;
  confirmToken?: string;
}

export interface ToolDefinition<TInput extends ConfirmableInput> {
  /** MCP tool name, e.g. "tickets_create". Must be unique across the whole server. */
  name: string;
  /** WHMCS domain grouping, used for WHMCS_MCP_ENABLE_DOMAINS filtering. */
  domain: ToolDomain;
  /** Safety tier; drives mode-gating and the confirm-token requirement. */
  tier: ToolTier;
  /** The WHMCS External API action this tool calls (for logging/docs only). */
  whmcsAction: string;
  /** Human-readable one-line description shown to the model. */
  description: string;
  /** zod schema for the tool's input. */
  inputSchema: z.ZodType<TInput>;
  /** MCP tool annotations; readOnlyHint/destructiveHint/idempotentHint should match `tier`. */
  annotations?: ToolAnnotations;
  /**
   * Called only after mode/domain/confirm gating has passed. Must not
   * perform side effects when `input.dryRun` is true — instead return a
   * preview of what would have been sent.
   */
  handler: (input: TInput, ctx: ToolContext) => Promise<ToolHandlerResult>;
  /**
   * For billing/destructive tools: builds the short human preview shown to
   * the caller on the first (unconfirmed) call, before a confirmToken is
   * minted. Defaults to a generic "this will call <whmcsAction>" message.
   */
  buildConfirmationPreview?: (input: TInput) => string;
}

/** Internal registry of every tool defined via `defineTool`, keyed by name. Used for docs generation and tests. */
const TOOL_REGISTRY = new Map<string, ToolDefinition<any>>();

/** Returns every tool definition registered so far (for scripts/gen-docs.ts and test/tools.test.ts). */
export function getAllToolDefinitions(): ReadonlyArray<ToolDefinition<any>> {
  return Array.from(TOOL_REGISTRY.values());
}

/**
 * Declares a tool. This only records the definition; it does not touch the
 * McpServer. Call `registerTools(server, ctx)` once all domain modules have
 * called `defineTool` to actually advertise the filtered set.
 */
export function defineTool<TInput extends ConfirmableInput>(
  def: ToolDefinition<TInput>,
): ToolDefinition<TInput> {
  if (TOOL_REGISTRY.has(def.name)) {
    throw new Error(
      `whmcs-mcp: duplicate tool name "${def.name}" registered by ${def.domain}`,
    );
  }
  TOOL_REGISTRY.set(def.name, def);
  return def;
}

/** MCP CallToolResult content-block shape, kept local to avoid an SDK version-coupling import. */
interface CallToolTextBlock {
  type: "text";
  text: string;
}

interface CallToolResult {
  content: CallToolTextBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function toTextSummary(data: unknown, fallback: string): string {
  if (data === null || data === undefined) return fallback;
  if (typeof data === "string") return data;
  try {
    const json = JSON.stringify(data, null, 2);
    // Keep tool text blocks bounded; full detail still lives in structuredContent.
    return json.length > 4000 ? `${json.slice(0, 4000)}\n… (truncated)` : json;
  } catch {
    return fallback;
  }
}

function wrapStructuredContent(data: unknown): Record<string, unknown> | undefined {
  if (data === null || data === undefined) return undefined;
  if (typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  // MCP structuredContent must be an object; wrap primitives/arrays.
  return { result: data };
}

/**
 * Builds the confirm-gated wrapper for billing/destructive tools.
 *
 * Flow:
 *  1. First call (no confirmToken): handler is NOT invoked. A preview is
 *     returned along with a freshly minted confirmToken bound to
 *     (tool name, a hash of the input). pendingConfirmation=true.
 *  2. Second call: caller must resend the exact same input plus the
 *     confirmToken from step 1. The token is validated (matches tool+input
 *     hash, not expired, not already used) and single-use consumed, then
 *     the real handler runs.
 *  3. `dryRun: true` always short-circuits to a preview and never consumes
 *     or requires a confirmToken, regardless of tier.
 */
async function runWithConfirmation<TInput extends ConfirmableInput>(
  def: ToolDefinition<TInput>,
  input: TInput,
): Promise<ToolHandlerResult> {
  if (input.dryRun) {
    return {
      data: {
        dryRun: true,
        tool: def.name,
        whmcsAction: def.whmcsAction,
        wouldSend: input,
      },
      summary: `[dryRun] ${def.name} would call WHMCS action "${def.whmcsAction}"; no request was sent.`,
      dryRun: true,
    };
  }

  const needsConfirm = requiresConfirmation(def.tier);
  if (!needsConfirm) {
    return def.handler(input, { whmcs: currentCtx.whmcs, config: currentCtx.config });
  }

  const { confirmToken, ...inputForHash } = input as Record<string, unknown>;

  if (!confirmToken) {
    const preview = def.buildConfirmationPreview
      ? def.buildConfirmationPreview(input)
      : `This will call WHMCS action "${def.whmcsAction}" via tool "${def.name}". Re-run with the returned confirmToken to proceed.`;
    const token = createConfirmToken({
      toolName: def.name,
      input: inputForHash,
    } satisfies ConfirmTokenPayload);
    return {
      data: {
        pendingConfirmation: true,
        tool: def.name,
        tier: def.tier,
        whmcsAction: def.whmcsAction,
        preview,
        confirmToken: token,
        expiresInSeconds: 300,
      },
      summary: `${preview} (confirmToken issued, expires in 5 minutes)`,
      pendingConfirmation: true,
    };
  }

  // Validates token freshness, single-use, and that it was minted for this
  // exact tool name + input hash — a confirmToken cannot be replayed against
  // different arguments or a different tool.
  const validation = consumeConfirmToken(confirmToken as string, {
    toolName: def.name,
    input: inputForHash,
  });
  if (!validation.ok) {
    return {
      data: {
        error: "invalid_confirm_token",
        reason: validation.reason,
        tool: def.name,
      },
      summary: `Confirmation failed for ${def.name}: ${validation.reason}. Call again without confirmToken to get a fresh one.`,
    };
  }

  return def.handler(input, { whmcs: currentCtx.whmcs, config: currentCtx.config });
}

/**
 * Module-scoped handler context, set once by `registerTools`. WHMCS MCP
 * runs a single client/config per process (one server instance per stdio
 * or HTTP session), so this avoids threading ctx through the MCP SDK's
 * per-call handler signature for every domain file.
 */
let currentCtx: ToolContext = null as unknown as ToolContext;

/**
 * Registers every tool that passes mode + domain filtering onto the given
 * McpServer. Call once at startup, after all domain modules (src/tools/*.ts)
 * have run their `defineTool(...)` calls (i.e. after importing them).
 */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  currentCtx = ctx;
  const mode = ctx.config.mode as WhmcsMcpMode;
  const enabledDomains = ctx.config.enabledDomains;

  let registered = 0;
  let skipped = 0;

  for (const def of TOOL_REGISTRY.values()) {
    if (!isDomainEnabled(def.domain, enabledDomains)) {
      skipped++;
      continue;
    }
    if (!isTierAllowedInMode(def.tier, mode)) {
      skipped++;
      continue;
    }

    const annotations: ToolAnnotations = {
      title: def.name,
      readOnlyHint: def.tier === "read",
      destructiveHint: def.tier === "destructive",
      idempotentHint: def.tier === "read",
      openWorldHint: true,
      ...def.annotations,
    };

    server.registerTool(
      def.name,
      {
        description: `[${def.tier}] ${def.description} (WHMCS action: ${def.whmcsAction})`,
        inputSchema: def.inputSchema as unknown as z.ZodRawShape,
        annotations,
      },
      async (rawInput: unknown): Promise<CallToolResult> => {
        const parsed = def.inputSchema.parse(rawInput) as ConfirmableInput & Record<string, unknown>;
        try {
          const result = await runWithConfirmation(def, parsed as never);
          const redacted = redactDeep(result.data, ctx.config.redactPii);
          const text = result.summary
            ? redactDeep(result.summary, ctx.config.redactPii) as string
            : toTextSummary(redacted, `${def.name} completed.`);

          return {
            content: [{ type: "text", text }],
            structuredContent: wrapStructuredContent(redacted),
          };
        } catch (err) {
          const apiErr = err as WhmcsApiError | Error;
          const message =
            "whmcsResult" in (apiErr as WhmcsApiError)
              ? (apiErr as WhmcsApiError).message
              : (apiErr as Error).message ?? "Unknown error";
          const redactedMessage = redactDeep(message, ctx.config.redactPii) as string;
          logger.error(`tool ${def.name} failed`, { whmcsAction: def.whmcsAction });
          return {
            content: [
              {
                type: "text",
                text: `Error calling ${def.name} (WHMCS action ${def.whmcsAction}): ${redactedMessage}`,
              },
            ],
            structuredContent: { error: redactedMessage, tool: def.name },
            isError: true,
          };
        }
      },
    );
    registered++;
  }

  logger.info(
    `whmcs-mcp: registered ${registered} tools, skipped ${skipped} (mode=${mode}, domains=${
      enabledDomains?.join(",") ?? "all"
    })`,
  );
}
