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

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool } from "./registry.js";
import type { WhmcsClient } from "../whmcs-client.js";
import {
  idParam,
  paginationSchema,
  dryRunSchema,
  confirmTokenSchema,
} from "../schemas/common.js";
import {
  ordersListSchema,
  ordersCreateSchema,
  ordersAcceptSchema,
  ordersPendingSchema,
  ordersCancelSchema,
  ordersMarkFraudSchema,
  ordersDeleteSchema,
} from "../schemas/orders.js";

/**
 * Serializes the WHMCS AddOrder "array-of-line-items" convention:
 * WHMCS expects parallel arrays keyed as pid[], billingcycle[], domain[],
 * configoptions[], customfields[], priceoverride[], and addons[] rather
 * than a JSON array of objects. This mirrors OrderFrm's documented POST
 * shape for the External API's AddOrder action.
 */
function serializeOrderItems(
  items: z.infer<typeof ordersCreateSchema>["items"],
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    pid: items.map((i) => i.pid),
  };
  if (items.some((i) => i.billingcycle !== undefined)) {
    out.billingcycle = items.map((i) => i.billingcycle ?? "");
  }
  if (items.some((i) => i.domain !== undefined)) {
    out.domain = items.map((i) => i.domain ?? "");
  }
  if (items.some((i) => i.configoptions !== undefined)) {
    out.configoptions = items.map((i) => i.configoptions ?? {});
  }
  if (items.some((i) => i.customfields !== undefined)) {
    out.customfields = items.map((i) => i.customfields ?? {});
  }
  if (items.some((i) => i.priceoverride !== undefined)) {
    out.priceoverride = items.map((i) => i.priceoverride ?? "");
  }
  if (items.some((i) => i.addons !== undefined)) {
    out.addons = items.map((i) => (i.addons ? i.addons.join(",") : ""));
  }
  return out;
}

/**
 * Serializes the parallel domain-registration arrays AddOrder accepts
 * alongside product items: domain[], domaintype[], regperiod[], eppcode[].
 */
function serializeOrderDomains(
  domains: NonNullable<z.infer<typeof ordersCreateSchema>["domains"]>,
): Record<string, unknown> {
  return {
    domain: domains.map((d) => d.domain),
    domaintype: domains.map((d) => d.domaintype),
    regperiod: domains.map((d) => d.regperiod),
    ...(domains.some((d) => d.eppcode !== undefined)
      ? { eppcode: domains.map((d) => d.eppcode ?? "") }
      : {}),
  };
}

export function registerOrderTools(server: McpServer, client: WhmcsClient): void {
  defineTool(server, client, {
    name: "orders_list",
    domain: "orders",
    tier: "read",
    whmcsAction: "GetOrders",
    description:
      "List WHMCS orders. Supports lookup by order id, client id, requestor, or status, with pagination.",
    inputSchema: ordersListSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    toParams: (input) => ({
      id: input.id,
      userid: input.userid,
      requestor_id: input.requestor_id,
      status: input.status,
      limitstart: input.limitstart,
      limitnum: input.limitnum,
    }),
  });

  defineTool(server, client, {
    name: "orders_get_statuses",
    domain: "orders",
    tier: "read",
    whmcsAction: "GetOrderStatuses",
    description: "List the order statuses configured in this WHMCS install.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    toParams: () => ({}),
  });

  defineTool(server, client, {
    name: "orders_create",
    domain: "orders",
    tier: "billing",
    whmcsAction: "AddOrder",
    description:
      "Create a new WHMCS order for a client (products and/or domains). Billing-tier: gated behind " +
      "WHMCS_MCP_MODE=full and a two-step confirm (call once for a preview, then again with the " +
      "returned confirmToken to execute). Supports dryRun to validate/serialize without calling WHMCS.",
    inputSchema: ordersCreateSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    requiresConfirm: true,
    supportsDryRun: true,
    toParams: (input) => ({
      clientid: input.clientid,
      paymentmethod: input.paymentmethod,
      ...serializeOrderItems(input.items),
      ...(input.domains ? serializeOrderDomains(input.domains) : {}),
      promocode: input.promocode,
      noinvoice: input.noinvoice,
      noinvoiceemail: input.noinvoiceemail,
      noemail: input.noemail,
    }),
  });

  defineTool(server, client, {
    name: "orders_accept",
    domain: "orders",
    tier: "write",
    whmcsAction: "AcceptOrder",
    description:
      "Accept a pending WHMCS order, optionally provisioning the service/module and registering the " +
      "domain. Write-tier: gated behind WHMCS_MCP_MODE=write|full and a two-step confirm.",
    inputSchema: ordersAcceptSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    requiresConfirm: true,
    supportsDryRun: true,
    toParams: (input) => ({
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
    }),
  });

  defineTool(server, client, {
    name: "orders_pending",
    domain: "orders",
    tier: "write",
    whmcsAction: "PendingOrder",
    description: "Move a WHMCS order back to Pending status.",
    inputSchema: ordersPendingSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    supportsDryRun: true,
    toParams: (input) => ({ orderid: input.orderid }),
  });

  defineTool(server, client, {
    name: "orders_cancel",
    domain: "orders",
    tier: "destructive",
    whmcsAction: "CancelOrder",
    description:
      "Cancel a WHMCS order, optionally cancelling its associated subscription/service. Destructive-tier: " +
      "requires a two-step confirm regardless of mode.",
    inputSchema: ordersCancelSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    requiresConfirm: true,
    supportsDryRun: true,
    toParams: (input) => ({
      orderid: input.orderid,
      cancelsub: input.cancelsub,
      noemail: input.noemail,
    }),
  });

  defineTool(server, client, {
    name: "orders_mark_fraud",
    domain: "orders",
    tier: "destructive",
    whmcsAction: "FraudOrder",
    description:
      "Mark a WHMCS order as fraudulent, optionally cancelling its associated subscription. " +
      "Destructive-tier: requires a two-step confirm regardless of mode.",
    inputSchema: ordersMarkFraudSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    requiresConfirm: true,
    supportsDryRun: true,
    toParams: (input) => ({
      orderid: input.orderid,
      cancelsub: input.cancelsub,
    }),
  });

  defineTool(server, client, {
    name: "orders_delete",
    domain: "orders",
    tier: "destructive",
    whmcsAction: "DeleteOrder",
    description:
      "Permanently delete a WHMCS order. WHMCS only allows this for orders already in Cancelled or " +
      "Fraud status. Destructive-tier: requires a two-step confirm regardless of mode.",
    inputSchema: ordersDeleteSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    requiresConfirm: true,
    supportsDryRun: true,
    toParams: (input) => ({ orderid: input.orderid }),
  });
}

// Re-exported so schemas/orders.ts consumers (docs generator, tests) can
// reference the same shared primitives this file uses for ids/pagination.
export { idParam, paginationSchema, dryRunSchema, confirmTokenSchema };
