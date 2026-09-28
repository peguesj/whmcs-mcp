/**
 * src/tools/products.ts
 *
 * MCP tool registrations for the "products" domain: product catalog reads,
 * client service/addon lookups, and service-lifecycle module actions
 * (create/suspend/unsuspend/terminate/change-package/upgrade).
 *
 * Domain membership mirrors the architecture plan's toolList entries whose
 * `domain` is "products" (clients_get_services and clients_get_addons are
 * tagged `domain":"products"` in the plan even though their WHMCS action
 * names are client-scoped lookups — they live here, not in tools/clients.ts):
 *
 *   - clients_get_services        (GetClientsProducts)   [read]
 *   - clients_get_addons          (GetClientsAddons)      [read]
 *   - products_list               (GetProducts)           [read]
 *   - products_get_promotions     (GetPromotions)         [read]
 *   - services_update             (UpdateClientProduct)   [write]
 *   - services_update_addon       (UpdateClientAddon)     [write]
 *   - services_upgrade            (UpgradeProduct)        [billing, confirm]
 *   - services_module_create      (ModuleCreate)          [write, confirm]
 *   - services_module_suspend     (ModuleSuspend)         [write, confirm]
 *   - services_module_unsuspend   (ModuleUnsuspend)       [write, confirm]
 *   - services_module_terminate   (ModuleTerminate)       [destructive, confirm]
 *   - services_module_change_package (ModuleChangePackage)[write, confirm]
 *
 * NOTE ON AUTH: the WHMCS External API (developers.whmcs.com/api-reference)
 * is invoked over a single form-encoded POST to `${WHMCS_API_URL}/includes/api.php`
 * with `identifier` + `secret` (+ optional `accesskey`) as body fields — there
 * is no bearer/header-based WHMCS REST API v1 in the documented 8.x/9.x
 * contract. All network I/O for this file goes through the shared
 * `WhmcsClient` (reached via `ctx.whmcs.call(...)`), which owns that request
 * shape; this file only builds params and wires tiers/annotations.
 *
 * Registration/tier/mode gating, dryRun short-circuiting, and the two-step
 * confirm-token flow for billing/destructive tools are all handled centrally
 * by `defineTool` (src/tools/registry.ts) — this file does not implement its
 * own confirm-token store.
 */

import { defineTool, type ToolContext, type ToolHandlerResult } from "./registry.js";
import type { WhmcsCallParams } from "../whmcs-client.js";
import {
  clientsGetServicesInputSchema,
  clientsGetAddonsInputSchema,
  productsListInputSchema,
  productsGetPromotionsInputSchema,
  servicesUpdateInputSchema,
  servicesUpdateAddonInputSchema,
  servicesUpgradeInputSchema,
  servicesModuleCreateInputSchema,
  servicesModuleSuspendInputSchema,
  servicesModuleUnsuspendInputSchema,
  servicesModuleTerminateInputSchema,
  servicesModuleChangePackageInputSchema,
} from "../schemas/products.js";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

defineTool({
  name: "clients_get_services",
  domain: "products",
  tier: "read",
  whmcsAction: "GetClientsProducts",
  description:
    "List a client's provisioned services/products (WHMCS GetClientsProducts). " +
    "Service passwords and other secrets are redacted from the response.",
  inputSchema: clientsGetServicesInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const result = await ctx.whmcs.call("GetClientsProducts", {
      clientid: input.clientid,
      serviceid: input.serviceid,
      pid: input.pid,
      domain: input.domain,
      username2: input.username2,
      limitstart: input.limitstart,
      limitnum: input.limitnum,
    });
    return { data: result };
  },
});

defineTool({
  name: "clients_get_addons",
  domain: "products",
  tier: "read",
  whmcsAction: "GetClientsAddons",
  description: "List addons attached to a client's service(s) (WHMCS GetClientsAddons).",
  inputSchema: clientsGetAddonsInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const result = await ctx.whmcs.call("GetClientsAddons", {
      clientid: input.clientid,
      serviceid: input.serviceid,
      addonid: input.addonid,
    });
    return { data: result };
  },
});

defineTool({
  name: "products_list",
  domain: "products",
  tier: "read",
  whmcsAction: "GetProducts",
  description: "List products/services in the product catalog (WHMCS GetProducts).",
  inputSchema: productsListInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const pid = Array.isArray(input.pid) ? input.pid.join(",") : input.pid;
    const params: WhmcsCallParams = {
      pid,
      gid: input.gid,
      module: input.module,
    };
    const result = await ctx.whmcs.call("GetProducts", params);
    return { data: result };
  },
});

defineTool({
  name: "products_get_promotions",
  domain: "products",
  tier: "read",
  whmcsAction: "GetPromotions",
  description: "List active promotions/discount codes (WHMCS GetPromotions).",
  inputSchema: productsGetPromotionsInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const params: WhmcsCallParams = { code: input.code };
    const result = await ctx.whmcs.call("GetPromotions", params);
    return { data: result };
  },
});

// ---------------------------------------------------------------------------
// Writes (service field updates — not module lifecycle actions)
// ---------------------------------------------------------------------------

defineTool({
  name: "services_update",
  domain: "products",
  tier: "write",
  whmcsAction: "UpdateClientProduct",
  description:
    "Update a client service's fields (status, billing, domain, notes, config options) " +
    "via WHMCS UpdateClientProduct. Supports dryRun to validate without calling WHMCS.",
  inputSchema: servicesUpdateInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const result = await ctx.whmcs.call("UpdateClientProduct", {
      serviceid: input.serviceid,
      pid: input.pid,
      status: input.status,
      nextduedate: input.nextduedate,
      billingcycle: input.billingcycle,
      recurringamount: input.recurringamount,
      domain: input.domain,
      notes: input.notes,
      customfields: input.customfields,
      configoptions: input.configoptions,
    });
    return { data: result, summary: `Service ${String(input.serviceid)} updated.` };
  },
});

defineTool({
  name: "services_update_addon",
  domain: "products",
  tier: "write",
  whmcsAction: "UpdateClientAddon",
  description: "Update a client addon's fields via WHMCS UpdateClientAddon.",
  inputSchema: servicesUpdateAddonInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const result = await ctx.whmcs.call("UpdateClientAddon", input);
    return { data: result, summary: `Addon ${String(input.id)} updated.` };
  },
});

// ---------------------------------------------------------------------------
// Billing-tier: product/config-option upgrade (confirm-gated)
// ---------------------------------------------------------------------------

defineTool({
  name: "services_upgrade",
  domain: "products",
  tier: "billing",
  whmcsAction: "UpgradeProduct",
  description:
    "Price and optionally execute a product or config-option upgrade (WHMCS UpgradeProduct). " +
    "Only advertised when WHMCS_MCP_MODE=full. First call without confirmToken returns a priced " +
    "preview and a confirmToken; the mutating call must echo that token within its TTL.",
  inputSchema: servicesUpgradeInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const result = await ctx.whmcs.call("UpgradeProduct", {
      serviceid: input.serviceid,
      type: input.type,
      newproductid: input.newproductid,
      newproductbillingcycle: input.newproductbillingcycle,
      configoptions: input.configoptions,
      paymentmethod: input.paymentmethod,
      promocode: input.promocode,
      calconly: false,
    });
    return { data: result, summary: `Service ${String(input.serviceid)} upgrade executed.` };
  },
  buildConfirmationPreview: (input) =>
    `This will ${input.type === "product" ? `change service ${String(input.serviceid)} to a new product/package` : `change service ${String(input.serviceid)}'s config options`} and generate an upgrade order/invoice.`,
});

// ---------------------------------------------------------------------------
// Module lifecycle actions (write/destructive, all confirm-gated)
// ---------------------------------------------------------------------------

defineTool({
  name: "services_module_create",
  domain: "products",
  tier: "write",
  whmcsAction: "ModuleCreate",
  description:
    "Run the provisioning module's create action for a service (WHMCS ModuleCreate). " +
    "Requires confirmToken from a prior preview call.",
  inputSchema: servicesModuleCreateInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const result = await ctx.whmcs.call("ModuleCreate", { serviceid: input.serviceid });
    return { data: result, summary: `Module create run for service ${String(input.serviceid)}.` };
  },
  buildConfirmationPreview: (input) => `This will run the provisioning module's create action for service ${String(input.serviceid)}.`,
});

defineTool({
  name: "services_module_suspend",
  domain: "products",
  tier: "write",
  whmcsAction: "ModuleSuspend",
  description:
    "Run the provisioning module's suspend action for a service (WHMCS ModuleSuspend). " +
    "Requires confirmToken from a prior preview call.",
  inputSchema: servicesModuleSuspendInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const result = await ctx.whmcs.call("ModuleSuspend", {
      serviceid: input.serviceid,
      suspendreason: input.suspendreason,
    });
    return { data: result, summary: `Module suspend run for service ${String(input.serviceid)}.` };
  },
  buildConfirmationPreview: (input) => `This will run the provisioning module's suspend action for service ${String(input.serviceid)}.`,
});

defineTool({
  name: "services_module_unsuspend",
  domain: "products",
  tier: "write",
  whmcsAction: "ModuleUnsuspend",
  description:
    "Run the provisioning module's unsuspend action for a service (WHMCS ModuleUnsuspend). " +
    "Requires confirmToken from a prior preview call.",
  inputSchema: servicesModuleUnsuspendInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const result = await ctx.whmcs.call("ModuleUnsuspend", { serviceid: input.serviceid });
    return { data: result, summary: `Module unsuspend run for service ${String(input.serviceid)}.` };
  },
  buildConfirmationPreview: (input) => `This will run the provisioning module's unsuspend action for service ${String(input.serviceid)}.`,
});

defineTool({
  name: "services_module_terminate",
  domain: "products",
  tier: "destructive",
  whmcsAction: "ModuleTerminate",
  description:
    "Run the provisioning module's terminate action for a service (WHMCS ModuleTerminate). " +
    "Destructive and irreversible at the module/provider layer. Requires confirmToken from " +
    "a prior preview call.",
  inputSchema: servicesModuleTerminateInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const result = await ctx.whmcs.call("ModuleTerminate", { serviceid: input.serviceid });
    return { data: result, summary: `Module terminate run for service ${String(input.serviceid)}.` };
  },
  buildConfirmationPreview: (input) =>
    `This will run the provisioning module's terminate action for service ${String(input.serviceid)}. This is irreversible at the module/provider layer.`,
});

defineTool({
  name: "services_module_change_package",
  domain: "products",
  tier: "write",
  whmcsAction: "ModuleChangePackage",
  description:
    "Run the provisioning module's change-package action for a service " +
    "(WHMCS ModuleChangePackage). Requires confirmToken from a prior preview call.",
  inputSchema: servicesModuleChangePackageInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const result = await ctx.whmcs.call("ModuleChangePackage", { serviceid: input.serviceid });
    return { data: result, summary: `Module change-package run for service ${String(input.serviceid)}.` };
  },
  buildConfirmationPreview: (input) => `This will run the provisioning module's change-package action for service ${String(input.serviceid)}.`,
});
