/**
 * src/tools/orders.ts
 *
 * MCP tool registrations for the WHMCS "orders" domain.
 *
 * Covers every toolList entry from the architecture plan whose `domain` is
 * "orders":
 *   - orders_list             -> GetOrders
 *   - orders_get_statuses     -> GetOrderStatuses
 *   - orders_create           -> AddOrder            [billing, confirm]
 *   - orders_accept           -> AcceptOrder         [write, confirm]
 *   - orders_pending          -> PendingOrder        [write]
 *   - orders_cancel           -> CancelOrder         [destructive, confirm]
 *   - orders_mark_fraud       -> FraudOrder          [destructive, confirm]
 *   - orders_delete           -> DeleteOrder         [destructive, confirm]
 *
 * Each tool is registered through `defineTool` (src/tools/registry.ts), which
 * applies WHMCS_MCP_MODE / WHMCS_MCP_ENABLE_DOMAINS filtering, the two-step
 * confirm-token flow for billing/destructive tiers, dryRun short-circuiting,
 * and output redaction before anything reaches the model. This file only
 * describes each tool's shape (schema, WHMCS action, tier, annotations) and
 * how its input maps onto WHMCS's documented POST parameters.
 *
 * NOTE ON AUTH / TRANSPORT: the actual HTTP call (auth header/body encoding,
 * retries, timeouts) lives entirely in src/whmcs-client.ts. This file never
 * calls fetch/WhmcsClient directly outside the `handler` passed to
 * `defineTool`, and never logs raw params.
 */

import { defineTool, type ToolContext, type ToolHandlerResult } from "./registry.js";
import {
  ordersListInputSchema,
  ordersGetStatusesInputSchema,
  ordersCreateInputSchema,
  ordersAcceptInputSchema,
  ordersPendingInputSchema,
  ordersCancelInputSchema,
  ordersMarkFraudInputSchema,
  ordersDeleteInputSchema,
  serializeOrderItemsToIndexedParams,
  serializeOrderDomainsToIndexedParams,
} from "../schemas/orders.js";

defineTool({
  name: "orders_list",
  domain: "orders",
  tier: "read",
  whmcsAction: "GetOrders",
  description:
    "List WHMCS orders. Supports lookup by order id, client id, requestor, or status, with pagination.",
  inputSchema: ordersListInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("GetOrders", {
      id: input.id,
      userid: input.userid,
      requestor_id: input.requestor_id,
      status: input.status,
      limitstart: input.limitstart,
      limitnum: input.limitnum,
    });
    return { data: res };
  },
});

defineTool({
  name: "orders_get_statuses",
  domain: "orders",
  tier: "read",
  whmcsAction: "GetOrderStatuses",
  description: "List the order statuses configured in this WHMCS install.",
  inputSchema: ordersGetStatusesInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (_input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("GetOrderStatuses", {});
    return { data: res };
  },
});

defineTool({
  name: "orders_create",
  domain: "orders",
  tier: "billing",
  whmcsAction: "AddOrder",
  description:
    "Create a new WHMCS order for a client (products and/or domains). Billing-tier: gated behind " +
    "WHMCS_MCP_MODE=full and a two-step confirm (call once for a preview, then again with the " +
    "returned confirmToken to execute). Supports dryRun to validate/serialize without calling WHMCS.",
  inputSchema: ordersCreateInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("AddOrder", {
      clientid: input.clientid,
      paymentmethod: input.paymentmethod,
      ...serializeOrderItemsToIndexedParams(input.items),
      ...serializeOrderDomainsToIndexedParams(input.domains),
      promocode: input.promocode,
      noinvoice: input.noinvoice,
      noinvoiceemail: input.noinvoiceemail,
      noemail: input.noemail,
    });
    return { data: res, summary: `Order created for client ${String(input.clientid)}.` };
  },
});

defineTool({
  name: "orders_accept",
  domain: "orders",
  tier: "write",
  whmcsAction: "AcceptOrder",
  description:
    "Accept a pending WHMCS order, optionally provisioning the service/module and registering the " +
    "domain. Write-tier: gated behind WHMCS_MCP_MODE=write|full and a two-step confirm.",
  inputSchema: ordersAcceptInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("AcceptOrder", {
      orderid: input.orderid,
      serverid: input.serverid,
      serviceusername: input.serviceusername,
      // servicepassword is intentionally accepted but never echoed back in any
      // tool result; src/safety/redact.ts strips it from logs/output as well.
      servicepassword: input.servicepassword,
      registrar: input.registrar,
      sendregistrar: input.sendregistrar,
      autosetup: input.autosetup,
      sendemail: input.sendemail,
    });
    return { data: res, summary: `Order ${String(input.orderid)} accepted.` };
  },
});

defineTool({
  name: "orders_pending",
  domain: "orders",
  tier: "write",
  whmcsAction: "PendingOrder",
  description: "Move a WHMCS order back to Pending status.",
  inputSchema: ordersPendingInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("PendingOrder", { orderid: input.orderid });
    return { data: res, summary: `Order ${String(input.orderid)} moved to Pending.` };
  },
});

defineTool({
  name: "orders_cancel",
  domain: "orders",
  tier: "destructive",
  whmcsAction: "CancelOrder",
  description:
    "Cancel a WHMCS order, optionally cancelling its associated subscription/service. Destructive-tier: " +
    "requires a two-step confirm regardless of mode.",
  inputSchema: ordersCancelInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("CancelOrder", {
      orderid: input.orderid,
      cancelsub: input.cancelsub,
      noemail: input.noemail,
    });
    return { data: res, summary: `Order ${String(input.orderid)} cancelled.` };
  },
  buildConfirmationPreview: (input) =>
    `This will cancel order ${String(input.orderid)}${input.cancelsub ? " and its associated subscription" : ""}.`,
});

defineTool({
  name: "orders_mark_fraud",
  domain: "orders",
  tier: "destructive",
  whmcsAction: "FraudOrder",
  description:
    "Mark a WHMCS order as fraudulent, optionally cancelling its associated subscription. " +
    "Destructive-tier: requires a two-step confirm regardless of mode.",
  inputSchema: ordersMarkFraudInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("FraudOrder", {
      orderid: input.orderid,
      cancelsub: input.cancelsub,
    });
    return { data: res, summary: `Order ${String(input.orderid)} marked as fraud.` };
  },
  buildConfirmationPreview: (input) => `This will mark order ${String(input.orderid)} as fraudulent.`,
});

defineTool({
  name: "orders_delete",
  domain: "orders",
  tier: "destructive",
  whmcsAction: "DeleteOrder",
  description:
    "Permanently delete a WHMCS order. WHMCS only allows this for orders already in Cancelled or " +
    "Fraud status. Destructive-tier: requires a two-step confirm regardless of mode.",
  inputSchema: ordersDeleteInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("DeleteOrder", { orderid: input.orderid });
    return { data: res, summary: `Order ${String(input.orderid)} deleted.` };
  },
  buildConfirmationPreview: (input) =>
    `This will permanently delete order ${String(input.orderid)}. This cannot be undone.`,
});
