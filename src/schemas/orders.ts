/**
 * src/schemas/orders.ts
 *
 * Zod input schemas for every `orders_*` MCP tool (domain: "orders" in the
 * architecture plan's toolList). Each schema mirrors the parameters
 * documented for the corresponding WHMCS External API action at
 * https://developers.whmcs.com/api-reference/ — verified compatible with the
 * 8.12.x and 9.0.x contract (action names and parameters are unchanged across
 * that range).
 *
 * These are INPUT schemas only: they describe what an MCP tool call accepts.
 * The actual HTTP request/auth/response-normalization lives in
 * src/whmcs-client.ts. Serialization from a schema's shape into WHMCS's
 * flat form-encoded params is the responsibility of src/tools/orders.ts,
 * which owns these schemas' tool registrations.
 *
 * pid[]/billingcycle[]/domain[]/etc. array serialization for AddOrder:
 * WHMCS's AddOrder action does NOT accept a JSON `items` array over the
 * form-encoded External API. It expects PHP-style indexed array params —
 * `pid[0]=1&pid[1]=2&billingcycle[0]=monthly&billingcycle[1]=annually&...` —
 * one positional slot per line item, plus a parallel `domains[]` array of
 * objects for any domain-registration/transfer line items in the same order.
 * This file keeps the ergonomic `items`/`domains` array shape at the schema
 * boundary (mirroring the plan's toolList summary) and documents the exact
 * wire serialization each tool handler in src/tools/orders.ts must perform
 * via `serializeOrderItemsToIndexedParams()` / `serializeOrderDomainsToIndexedParams()`
 * below, rather than duplicating that logic ad hoc in the tool layer.
 *
 * Tiers (read | write | billing | destructive) are attached here as metadata
 * alongside each schema so src/tools/registry.ts can apply WHMCS_MCP_MODE /
 * WHMCS_MCP_ENABLE_DOMAINS filtering and the two-step confirm flow without
 * re-deriving the tier from the plan by hand.
 */

import { z } from "zod";
import {
  confirmTokenSchema,
  dryRunSchema,
  idSchema,
  moneySchema,
  noEmailFlagSchema,
  paginationSchema,
} from "./common.js";

/** WHMCS's documented order statuses (GetOrders `status` filter, AddOrder result). */
export const orderStatusSchema = z.enum([
  "Pending",
  "Active",
  "Fraud",
  "Cancelled",
]);

/** AddOrder's `domaintype` per domain line item. */
export const orderDomainTypeSchema = z.enum(["register", "transfer"]);

/* ------------------------------------------------------------------ */
/* Shared line-item shapes for orders_create (AddOrder)                */
/* ------------------------------------------------------------------ */

/**
 * A single product/service line item for AddOrder. `configoptions` and
 * `customfields` are passed through as plain records; the tool handler is
 * responsible for WHMCS's own indexed-array encoding of any nested config
 * option groups (`configoption[<pid-index>][<optionid>]=<value>`), which is
 * itself a per-product, per-index scheme documented alongside AddOrder.
 */
export const orderItemSchema = z.object({
  pid: idSchema,
  billingcycle: z
    .enum([
      "free",
      "onetime",
      "monthly",
      "quarterly",
      "semiannually",
      "annually",
      "biennially",
      "triennially",
    ])
    .optional(),
  domain: z.string().optional(),
  configoptions: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  customfields: z.record(z.string(), z.string()).optional(),
  priceoverride: moneySchema.optional(),
  /** Ids of any addons to attach to this product line item. */
  addons: z.array(idSchema).optional(),
});
export type OrderItem = z.infer<typeof orderItemSchema>;

/**
 * A single domain line item for AddOrder (registration or transfer),
 * serialized into WHMCS's parallel `domains[]` indexed array.
 */
export const orderDomainItemSchema = z.object({
  domain: z.string().min(1),
  domaintype: orderDomainTypeSchema,
  regperiod: z.number().int().positive(),
  /** Required for domaintype "transfer"; the registrar EPP/auth code. Never logged. */
  eppcode: z.string().optional(),
});
export type OrderDomainItem = z.infer<typeof orderDomainItemSchema>;

/* ------------------------------------------------------------------ */
/* orders_list -> WHMCS action: GetOrders                              */
/* ------------------------------------------------------------------ */
export const ordersListInputSchema = paginationSchema.extend({
  id: idSchema.optional(),
  userid: idSchema.optional(),
  requestor_id: idSchema.optional(),
  status: orderStatusSchema.optional(),
});
export type OrdersListInput = z.infer<typeof ordersListInputSchema>;

/* ------------------------------------------------------------------ */
/* orders_get_statuses -> WHMCS action: GetOrderStatuses                */
/* ------------------------------------------------------------------ */
export const ordersGetStatusesInputSchema = z.object({});
export type OrdersGetStatusesInput = z.infer<typeof ordersGetStatusesInputSchema>;

/* ------------------------------------------------------------------ */
/* orders_create -> WHMCS action: AddOrder  [billing, confirm]         */
/* ------------------------------------------------------------------ */
export const ordersCreateInputSchema = z
  .object({
    clientid: idSchema,
    paymentmethod: z.string().min(1),
    items: z.array(orderItemSchema).min(1),
    domains: z.array(orderDomainItemSchema).optional(),
    promocode: z.string().optional(),
    noinvoice: z.boolean().optional(),
    noinvoiceemail: z.boolean().optional(),
    noemail: noEmailFlagSchema,
    dryRun: dryRunSchema,
    confirmToken: confirmTokenSchema,
  })
  .refine(
    (v) => v.items.every((item, i, arr) => (item.domain === undefined) || arr[i] !== undefined),
    { message: "Malformed items array" },
  );
export type OrdersCreateInput = z.infer<typeof ordersCreateInputSchema>;

/**
 * Serializes `OrdersCreateInput.items` into WHMCS AddOrder's PHP-style
 * indexed array params: `pid[i]`, `billingcycle[i]`, `domain[i]`,
 * `priceoverride[i]`, plus a base64-encoded `customfields[i]` map and a
 * bracketed `configoptions[i][optionid]` map per WHMCS's documented
 * per-line-item option encoding. Addons are flattened to `addons[i][]`.
 *
 * Returns a flat map of WHMCS wire param name -> value; the caller
 * (src/whmcs-client.ts) is responsible for the final form-encoding,
 * including PHP-array bracket notation for repeated/nested keys.
 */
export function serializeOrderItemsToIndexedParams(
  items: readonly OrderItem[],
): Record<string, string> {
  const params: Record<string, string> = {};
  items.forEach((item, i) => {
    params[`pid[${i}]`] = String(item.pid);
    if (item.billingcycle !== undefined) {
      params[`billingcycle[${i}]`] = item.billingcycle;
    }
    if (item.domain !== undefined) {
      params[`domain[${i}]`] = item.domain;
    }
    if (item.priceoverride !== undefined) {
      params[`priceoverride[${i}]`] = String(item.priceoverride);
    }
    if (item.customfields !== undefined) {
      // WHMCS expects a base64-encoded serialized map per line item.
      params[`customfields[${i}]`] = Buffer.from(
        JSON.stringify(item.customfields),
        "utf-8",
      ).toString("base64");
    }
    if (item.configoptions !== undefined) {
      for (const [optionId, value] of Object.entries(item.configoptions)) {
        params[`configoptions[${i}][${optionId}]`] = String(value);
      }
    }
    if (item.addons !== undefined) {
      item.addons.forEach((addonId, j) => {
        params[`addons[${i}][${j}]`] = String(addonId);
      });
    }
  });
  return params;
}

/**
 * Serializes `OrdersCreateInput.domains` into WHMCS AddOrder's parallel
 * `domains[i][...]` indexed array. Never logs `eppcode`.
 */
export function serializeOrderDomainsToIndexedParams(
  domains: readonly OrderDomainItem[] | undefined,
): Record<string, string> {
  const params: Record<string, string> = {};
  (domains ?? []).forEach((d, i) => {
    params[`domains[${i}][domain]`] = d.domain;
    params[`domains[${i}][domaintype]`] = d.domaintype;
    params[`domains[${i}][regperiod]`] = String(d.regperiod);
    if (d.eppcode !== undefined) {
      params[`domains[${i}][eppcode]`] = d.eppcode;
    }
  });
  return params;
}

/* ------------------------------------------------------------------ */
/* orders_accept -> WHMCS action: AcceptOrder  [write, confirm]        */
/* ------------------------------------------------------------------ */
export const ordersAcceptInputSchema = z.object({
  orderid: idSchema,
  serverid: idSchema.optional(),
  serviceusername: z.string().optional(),
  /** Never echoed back in results; write-only pass-through to WHMCS. */
  servicepassword: z.string().optional(),
  registrar: z.string().optional(),
  sendregistrar: z.boolean().optional(),
  autosetup: z.boolean().optional(),
  sendemail: z.boolean().optional(),
  dryRun: dryRunSchema,
  confirmToken: confirmTokenSchema,
});
export type OrdersAcceptInput = z.infer<typeof ordersAcceptInputSchema>;

/* ------------------------------------------------------------------ */
/* orders_pending -> WHMCS action: PendingOrder  [write]               */
/* ------------------------------------------------------------------ */
export const ordersPendingInputSchema = z.object({
  orderid: idSchema,
  dryRun: dryRunSchema,
});
export type OrdersPendingInput = z.infer<typeof ordersPendingInputSchema>;

/* ------------------------------------------------------------------ */
/* orders_cancel -> WHMCS action: CancelOrder  [destructive, confirm]  */
/* ------------------------------------------------------------------ */
export const ordersCancelInputSchema = z.object({
  orderid: idSchema,
  cancelsub: z.boolean().optional(),
  noemail: noEmailFlagSchema,
  confirmToken: confirmTokenSchema,
});
export type OrdersCancelInput = z.infer<typeof ordersCancelInputSchema>;

/* ------------------------------------------------------------------ */
/* orders_mark_fraud -> WHMCS action: FraudOrder  [destructive, confirm] */
/* ------------------------------------------------------------------ */
export const ordersMarkFraudInputSchema = z.object({
  orderid: idSchema,
  cancelsub: z.boolean().optional(),
  confirmToken: confirmTokenSchema,
});
export type OrdersMarkFraudInput = z.infer<typeof ordersMarkFraudInputSchema>;

/* ------------------------------------------------------------------ */
/* orders_delete -> WHMCS action: DeleteOrder  [destructive, confirm]  */
/* ------------------------------------------------------------------ */
// WHMCS only permits DeleteOrder on orders already in status Cancelled or
// Fraud; the tool handler in src/tools/orders.ts should surface WHMCS's own
// rejection rather than pre-validate status here (status isn't known without
// a prior GetOrders/GetOrder read).
export const ordersDeleteInputSchema = z.object({
  orderid: idSchema,
  confirmToken: confirmTokenSchema,
});
export type OrdersDeleteInput = z.infer<typeof ordersDeleteInputSchema>;

/* ------------------------------------------------------------------ */
/* Registry metadata: one entry per orders_* tool, consumed by         */
/* src/tools/orders.ts and src/tools/registry.ts.                      */
/* ------------------------------------------------------------------ */

export type ToolTier = "read" | "write" | "billing" | "destructive";

export interface OrderToolDefinition {
  name: string;
  whmcsAction: string;
  tier: ToolTier;
  schema: z.ZodTypeAny;
}

export const ORDERS_TOOL_DEFINITIONS: readonly OrderToolDefinition[] = [
  { name: "orders_list", whmcsAction: "GetOrders", tier: "read", schema: ordersListInputSchema },
  { name: "orders_get_statuses", whmcsAction: "GetOrderStatuses", tier: "read", schema: ordersGetStatusesInputSchema },
  { name: "orders_create", whmcsAction: "AddOrder", tier: "billing", schema: ordersCreateInputSchema },
  { name: "orders_accept", whmcsAction: "AcceptOrder", tier: "write", schema: ordersAcceptInputSchema },
  { name: "orders_pending", whmcsAction: "PendingOrder", tier: "write", schema: ordersPendingInputSchema },
  { name: "orders_cancel", whmcsAction: "CancelOrder", tier: "destructive", schema: ordersCancelInputSchema },
  { name: "orders_mark_fraud", whmcsAction: "FraudOrder", tier: "destructive", schema: ordersMarkFraudInputSchema },
  { name: "orders_delete", whmcsAction: "DeleteOrder", tier: "destructive", schema: ordersDeleteInputSchema },
] as const;
