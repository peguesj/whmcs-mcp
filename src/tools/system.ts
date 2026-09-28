/**
 * src/tools/system.ts
 *
 * MCP tool registrations for the WHMCS "system" domain: server-level
 * metadata/reporting actions plus the `whmcs_raw_call` escape hatch.
 *
 * Each tool maps 1:1 to a documented WHMCS External API action
 * (https://developers.whmcs.com/api-reference/) and is registered through
 * the shared `defineTool` helper in `./registry.js`, which applies:
 *   - WHMCS_MCP_MODE / WHMCS_MCP_ENABLE_DOMAINS advertisement filtering
 *   - tier gating (read | write | billing | destructive)
 *   - dryRun short-circuiting for mutating tools (no network call, returns
 *     a preview of what would have been sent)
 *   - the two-step confirmToken flow for billing/destructive-tier tools
 *   - deep redaction of the WHMCS response before it reaches the model
 *
 * This file owns every `toolList` entry from the architecture plan whose
 * `domain` is "system":
 *   system_get_details, system_get_stats, system_get_activity_log,
 *   system_get_admin_details, system_get_todo_items,
 *   system_get_email_templates, system_send_email,
 *   system_get_payment_methods, system_get_currencies, system_log_activity,
 *   whmcs_raw_call
 *
 * Input schemas live in `../schemas/system.js` and mirror WHMCS's documented
 * per-action parameter tables (including the bundled `whmcs_raw_call`
 * action allowlist).
 *
 * WHMCS auth/transport note: the WHMCS External API
 * (`POST {WHMCS_API_URL}/includes/api.php`) is a single form-encoded
 * endpoint, not a generic REST API with an Authorization header.
 * Authentication is `identifier` + `secret` (optionally `accesskey`) in the
 * POST body; `../whmcs-client.js` is the ONLY place that constructs that
 * body. This file never talks to the network directly — every handler below
 * calls through `ctx.whmcs.call(action, params)`.
 *
 * Version discovery: `system_get_details` (WhmcsDetails) is the tool other
 * parts of this server, and callers, should invoke to confirm the connected
 * instance's `whmcs.version` at startup. See docs/version-compatibility.md.
 * It is also exposed as the `whmcs://system/version` resource
 * (src/resources.ts) for callers that just want the version without
 * invoking a tool.
 */

import { defineTool, type ToolContext, type ToolHandlerResult } from "./registry.js";
import { unwrapCollection } from "../whmcs-client.js";
import {
  systemGetDetailsSchema,
  systemGetStatsSchema,
  systemGetActivityLogSchema,
  systemGetAdminDetailsSchema,
  systemGetTodoItemsSchema,
  systemGetEmailTemplatesSchema,
  systemSendEmailSchema,
  systemGetPaymentMethodsSchema,
  systemGetCurrenciesSchema,
  systemLogActivitySchema,
  whmcsRawCallSchema,
  type SystemSendEmailInput,
  type WhmcsRawCallInput,
} from "../schemas/system.js";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

defineTool({
  name: "system_get_details",
  domain: "system",
  tier: "read",
  whmcsAction: "WhmcsDetails",
  description:
    "Get the connected WHMCS instance's version, license, and URL details. Use this to confirm runtime version compatibility (8.x/9.x).",
  inputSchema: systemGetDetailsSchema,
  annotations: {
    title: "Get WHMCS system details",
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (_input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("WhmcsDetails", {});
    const version = typeof res.version === "string" ? res.version : undefined;
    return {
      data: res,
      summary: version
        ? `Connected WHMCS instance reports version ${version}.`
        : "Connected WHMCS instance did not report a version string.",
    };
  },
});

defineTool({
  name: "system_get_stats",
  domain: "system",
  tier: "read",
  whmcsAction: "GetStats",
  description:
    "Get dashboard-style summary statistics (client/order/invoice/ticket counts, income timeline).",
  inputSchema: systemGetStatsSchema,
  annotations: {
    title: "Get system statistics",
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("GetStats", {
      timeline_days: input.timeline_days,
    });
    return { data: res };
  },
});

defineTool({
  name: "system_get_activity_log",
  domain: "system",
  tier: "read",
  whmcsAction: "GetActivityLog",
  description:
    "Get admin/system activity log entries, optionally filtered by client, admin user, date, description substring, or IP address.",
  inputSchema: systemGetActivityLogSchema,
  annotations: {
    title: "Get activity log",
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("GetActivityLog", {
      limitstart: input.limitstart,
      limitnum: input.limitnum,
      clientid: input.clientid,
      date: input.date,
      user: input.user,
      description: input.description,
      ipaddress: input.ipaddress,
    });
    // WHMCS returns { activity: { entry: [...] }, numreturned, totalresults, ... }.
    const activity = unwrapCollection<Record<string, unknown>>(res.activity, "entry");
    return {
      data: { ...res, activity },
      summary: `Returned ${activity.length} activity log entr${activity.length === 1 ? "y" : "ies"}.`,
    };
  },
});

defineTool({
  name: "system_get_admin_details",
  domain: "system",
  tier: "read",
  whmcsAction: "GetAdminDetails",
  description:
    "Get the identity, role, and permissions of the admin the configured API credentials resolve to. Secret-shaped fields are redacted before the result reaches the model.",
  inputSchema: systemGetAdminDetailsSchema,
  annotations: {
    title: "Get API-credential admin identity",
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (_input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("GetAdminDetails", {});
    return { data: res };
  },
});

defineTool({
  name: "system_get_todo_items",
  domain: "system",
  tier: "read",
  whmcsAction: "GetToDoItems",
  description: "Get admin To-Do List items, optionally filtered by status.",
  inputSchema: systemGetTodoItemsSchema,
  annotations: {
    title: "Get To-Do List items",
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("GetToDoItems", {
      status: input.status,
      limitstart: input.limitstart,
      limitnum: input.limitnum,
    });
    const items = unwrapCollection<Record<string, unknown>>(res.items, "item");
    return {
      data: { ...res, items },
      summary: `Returned ${items.length} to-do item${items.length === 1 ? "" : "s"}.`,
    };
  },
});

defineTool({
  name: "system_get_email_templates",
  domain: "system",
  tier: "read",
  whmcsAction: "GetEmailTemplates",
  description:
    "Get configured email templates, optionally filtered by type (general/product/domain/invoice/support/affiliate) and language.",
  inputSchema: systemGetEmailTemplatesSchema,
  annotations: {
    title: "Get email templates",
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("GetEmailTemplates", {
      type: input.type,
      language: input.language,
    });
    const templates = unwrapCollection<Record<string, unknown>>(res.templates, "template");
    return {
      data: { ...res, templates },
      summary: `Returned ${templates.length} email template${templates.length === 1 ? "" : "s"}.`,
    };
  },
});

defineTool({
  name: "system_get_payment_methods",
  domain: "system",
  tier: "read",
  whmcsAction: "GetPaymentMethods",
  description: "Get the payment gateways/methods currently active on this WHMCS instance.",
  inputSchema: systemGetPaymentMethodsSchema,
  annotations: {
    title: "Get active payment methods",
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (_input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("GetPaymentMethods", {});
    const paymentmethods = unwrapCollection<Record<string, unknown>>(
      res.paymentmethods,
      "paymentmethod",
    );
    return { data: { ...res, paymentmethods } };
  },
});

defineTool({
  name: "system_get_currencies",
  domain: "system",
  tier: "read",
  whmcsAction: "GetCurrencies",
  description: "Get configured currencies and their exchange rates.",
  inputSchema: systemGetCurrenciesSchema,
  annotations: {
    title: "Get configured currencies",
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (_input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("GetCurrencies", {});
    const currencies = unwrapCollection<Record<string, unknown>>(res.currencies, "currency");
    return { data: { ...res, currencies } };
  },
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

defineTool({
  name: "system_send_email",
  domain: "system",
  tier: "write",
  whmcsAction: "SendEmail",
  description:
    "Send a WHMCS email: either a pre-defined template (mode='template', messagename) or an ad hoc message (mode='custom', customtype/customsubject/custommessage) to the party associated with `id`.",
  inputSchema: systemSendEmailSchema,
  annotations: {
    title: "Send an email via WHMCS",
    readOnlyHint: false,
    idempotentHint: false,
  },
  handler: async (
    input: SystemSendEmailInput,
    ctx: ToolContext,
  ): Promise<ToolHandlerResult> => {
    const params =
      input.mode === "template"
        ? { id: input.id, messagename: input.messagename, customvars: input.customvars }
        : {
            id: input.id,
            customtype: input.customtype,
            customsubject: input.customsubject,
            custommessage: input.custommessage,
            customvars: input.customvars,
          };
    const res = await ctx.whmcs.call("SendEmail", serializeCustomvars(params));
    return {
      data: res,
      summary:
        input.mode === "template"
          ? `Sent template "${input.messagename}" for entity id ${input.id}.`
          : `Sent ad hoc email (type "${input.customtype}") for entity id ${input.id}.`,
    };
  },
});

defineTool({
  name: "system_log_activity",
  domain: "system",
  tier: "write",
  whmcsAction: "LogActivity",
  description:
    "Write a custom entry into the WHMCS activity log, optionally attributed to a client.",
  inputSchema: systemLogActivitySchema,
  annotations: {
    title: "Log a custom activity entry",
    readOnlyHint: false,
    idempotentHint: false,
  },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("LogActivity", {
      description: input.description,
      clientid: input.clientid,
    });
    return { data: res, summary: `Logged activity entry: "${input.description}".` };
  },
});

// ---------------------------------------------------------------------------
// whmcs_raw_call -- escape hatch, full mode only, confirm-gated
// ---------------------------------------------------------------------------

defineTool({
  name: "whmcs_raw_call",
  domain: "system",
  tier: "destructive",
  whmcsAction: "<any documented action>",
  description:
    "Escape hatch: call any documented WHMCS 8.x/9.x External API action not covered by a typed tool. The `action` name is validated against a bundled allowlist of documented actions (see src/schemas/system.ts); unknown actions are rejected even in full mode. Classified as the highest (destructive) tier since it can reach billing/destructive WHMCS actions directly, so it always requires confirmToken and is only advertised under WHMCS_MCP_MODE=full.",
  inputSchema: whmcsRawCallSchema,
  annotations: {
    title: "Raw WHMCS API call (escape hatch)",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  buildConfirmationPreview: (input: WhmcsRawCallInput) =>
    `This will call the raw WHMCS External API action "${input.action}" with the parameters you provided. This bypasses per-tool schemas and safety copy for that action -- review the params carefully before confirming.`,
  handler: async (input: WhmcsRawCallInput, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call(input.action, input.params);
    return {
      data: res,
      summary: `Called raw WHMCS action "${input.action}".`,
    };
  },
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * WHMCS's SendEmail action expects `customvars` as a base64-encoded
 * serialized PHP array on the wire in some documented examples, but also
 * accepts simple `varname=value` form fields in others depending on
 * version. To keep this client's transport (form-encoded key/value pairs
 * only, see whmcs-client.ts) unambiguous across 8.12.x/9.0.x, we flatten
 * `customvars` into individual `customvarsN`-style fields is NOT done here;
 * instead we pass it through as a single JSON-stringified value under the
 * `customvars` key, which WHMCS accepts as a raw string for this action.
 * If a future WHMCS release requires the base64(serialize()) form instead,
 * this is the single function to change.
 */
function serializeCustomvars<T extends { customvars?: Record<string, unknown> }>(
  params: T,
): Omit<T, "customvars"> & { customvars?: string } {
  const { customvars, ...rest } = params;
  if (customvars === undefined) return rest;
  return { ...rest, customvars: JSON.stringify(customvars) };
}
