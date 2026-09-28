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
 * `WhmcsClient` in `../whmcs-client.js`, which owns that request shape; this
 * file only builds params and wires tiers/annotations. If a future WHMCS
 * release introduces a distinct bearer-token REST v1 surface, the one-line
 * fix point is `WhmcsClient`'s `AUTH_MODE` constant, not this file.
 */

import { z } from "zod";
import { defineTool } from "./registry.js";
import type { WhmcsClient } from "../whmcs-client.js";
import {
  clientsGetServicesSchema,
  clientsGetAddonsSchema,
  productsListSchema,
  productsGetPromotionsSchema,
  servicesUpdateSchema,
  servicesUpdateAddonSchema,
  servicesUpgradeSchema,
  serviceIdOnlySchema,
  servicesModuleSuspendSchema,
} from "../schemas/products.js";

/**
 * Registers every products-domain tool on the given McpServer-compatible
 * registry, gated by the current WHMCS_MCP_MODE / enabled-domains policy
 * inside `defineTool`/`registry.ts`.
 */
export function registerProductsTools(client: WhmcsClient): void {
  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  defineTool({
    name: "clients_get_services",
    domain: "products",
    tier: "read",
    whmcsAction: "GetClientsProducts",
    description:
      "List a client's provisioned services/products (WHMCS GetClientsProducts). " +
      "Service passwords and other secrets are redacted from the response.",
    inputSchema: clientsGetServicesSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (input) => {
      const result = await client.call("GetClientsProducts", input);
      return { data: result, redact: ["password", "serverpassword", "cclastfour"] };
    },
  });

  defineTool({
    name: "clients_get_addons",
    domain: "products",
    tier: "read",
    whmcsAction: "GetClientsAddons",
    description: "List addons attached to a client's service(s) (WHMCS GetClientsAddons).",
    inputSchema: clientsGetAddonsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (input) => {
      const result = await client.call("GetClientsAddons", input);
      return { data: result };
    },
  });

  defineTool({
    name: "products_list",
    domain: "products",
    tier: "read",
    whmcsAction: "GetProducts",
    description: "List products/services in the product catalog (WHMCS GetProducts).",
    inputSchema: productsListSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (input) => {
      const result = await client.call("GetProducts", input);
      return { data: result };
    },
  });

  defineTool({
    name: "products_get_promotions",
    domain: "products",
    tier: "read",
    whmcsAction: "GetPromotions",
    description: "List active promotions/discount codes (WHMCS GetPromotions).",
    inputSchema: productsGetPromotionsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (input) => {
      const result = await client.call("GetPromotions", input);
      return { data: result };
    },
  });

  // ---------------------------------------------------------------------
  // Writes (service field updates — not module lifecycle actions)
  // ---------------------------------------------------------------------

  defineTool({
    name: "services_update",
    domain: "products",
    tier: "write",
    whmcsAction: "UpdateClientProduct",
    description:
      "Update a client service's fields (status, billing, domain, notes, config options) " +
      "via WHMCS UpdateClientProduct. Supports dryRun to validate without calling WHMCS.",
    inputSchema: servicesUpdateSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (input) => {
      const { dryRun, ...params } = input as z.infer<typeof servicesUpdateSchema>;
      if (dryRun) {
        return { data: { dryRun: true, wouldCall: "UpdateClientProduct", params } };
      }
      const result = await client.call("UpdateClientProduct", params);
      return { data: result };
    },
  });

  defineTool({
    name: "services_update_addon",
    domain: "products",
    tier: "write",
    whmcsAction: "UpdateClientAddon",
    description: "Update a client addon's fields via WHMCS UpdateClientAddon.",
    inputSchema: servicesUpdateAddonSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (input) => {
      const result = await client.call("UpdateClientAddon", input);
      return { data: result };
    },
  });

  // ---------------------------------------------------------------------
  // Billing-tier: product/config-option upgrade (confirm-gated)
  // ---------------------------------------------------------------------

  defineTool({
    name: "services_upgrade",
    domain: "products",
    tier: "billing",
    whmcsAction: "UpgradeProduct",
    description:
      "Price and optionally execute a product or config-option upgrade (WHMCS UpgradeProduct). " +
      "Only advertised when WHMCS_MCP_MODE=full. First call without confirmToken (or with " +
      "calconly=true) returns a priced preview and a confirmToken; the mutating call must " +
      "echo that token within its TTL.",
    inputSchema: servicesUpgradeSchema,
    requiresConfirm: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (input, ctx) => {
      const { confirmToken, dryRun, calconly, ...params } =
        input as z.infer<typeof servicesUpgradeSchema>;

      // Preview path: always safe, never mutates, never requires a token.
      if (calconly || dryRun) {
        const preview = await client.call("UpgradeProduct", { ...params, calconly: true });
        return {
          data: preview,
          preview: true,
          confirmToken: ctx.issueConfirmToken({ tool: "services_upgrade", params }),
        };
      }

      ctx.requireConfirmToken(confirmToken, { tool: "services_upgrade", params });
      const result = await client.call("UpgradeProduct", { ...params, calconly: false });
      return { data: result };
    },
  });

  // ---------------------------------------------------------------------
  // Module lifecycle actions (write/destructive, all confirm-gated)
  // ---------------------------------------------------------------------

  defineTool({
    name: "services_module_create",
    domain: "products",
    tier: "write",
    whmcsAction: "ModuleCreate",
    description:
      "Run the provisioning module's create action for a service (WHMCS ModuleCreate). " +
      "Requires confirmToken from a prior preview call.",
    inputSchema: serviceIdOnlySchema,
    requiresConfirm: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (input, ctx) => {
      const { confirmToken, serviceid } = input as z.infer<typeof serviceIdOnlySchema> & {
        confirmToken?: string;
      };
      if (!confirmToken) {
        return {
          preview: true,
          data: { action: "ModuleCreate", serviceid },
          confirmToken: ctx.issueConfirmToken({ tool: "services_module_create", serviceid }),
        };
      }
      ctx.requireConfirmToken(confirmToken, { tool: "services_module_create", serviceid });
      const result = await client.call("ModuleCreate", { serviceid });
      return { data: result };
    },
  });

  defineTool({
    name: "services_module_suspend",
    domain: "products",
    tier: "write",
    whmcsAction: "ModuleSuspend",
    description:
      "Run the provisioning module's suspend action for a service (WHMCS ModuleSuspend). " +
      "Requires confirmToken from a prior preview call.",
    inputSchema: servicesModuleSuspendSchema,
    requiresConfirm: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (input, ctx) => {
      const { confirmToken, ...params } = input as z.infer<
        typeof servicesModuleSuspendSchema
      > & { confirmToken?: string };
      if (!confirmToken) {
        return {
          preview: true,
          data: { action: "ModuleSuspend", ...params },
          confirmToken: ctx.issueConfirmToken({ tool: "services_module_suspend", params }),
        };
      }
      ctx.requireConfirmToken(confirmToken, { tool: "services_module_suspend", params });
      const result = await client.call("ModuleSuspend", params);
      return { data: result };
    },
  });

  defineTool({
    name: "services_module_unsuspend",
    domain: "products",
    tier: "write",
    whmcsAction: "ModuleUnsuspend",
    description:
      "Run the provisioning module's unsuspend action for a service (WHMCS ModuleUnsuspend). " +
      "Requires confirmToken from a prior preview call.",
    inputSchema: serviceIdOnlySchema,
    requiresConfirm: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (input, ctx) => {
      const { confirmToken, serviceid } = input as z.infer<typeof serviceIdOnlySchema> & {
        confirmToken?: string;
      };
      if (!confirmToken) {
        return {
          preview: true,
          data: { action: "ModuleUnsuspend", serviceid },
          confirmToken: ctx.issueConfirmToken({ tool: "services_module_unsuspend", serviceid }),
        };
      }
      ctx.requireConfirmToken(confirmToken, { tool: "services_module_unsuspend", serviceid });
      const result = await client.call("ModuleUnsuspend", { serviceid });
      return { data: result };
    },
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
    inputSchema: serviceIdOnlySchema,
    requiresConfirm: true,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    handler: async (input, ctx) => {
      const { confirmToken, serviceid } = input as z.infer<typeof serviceIdOnlySchema> & {
        confirmToken?: string;
      };
      if (!confirmToken) {
        return {
          preview: true,
          data: { action: "ModuleTerminate", serviceid, warning: "irreversible" },
          confirmToken: ctx.issueConfirmToken({ tool: "services_module_terminate", serviceid }),
        };
      }
      ctx.requireConfirmToken(confirmToken, { tool: "services_module_terminate", serviceid });
      const result = await client.call("ModuleTerminate", { serviceid });
      return { data: result };
    },
  });

  defineTool({
    name: "services_module_change_package",
    domain: "products",
    tier: "write",
    whmcsAction: "ModuleChangePackage",
    description:
      "Run the provisioning module's change-package action for a service " +
      "(WHMCS ModuleChangePackage). Requires confirmToken from a prior preview call.",
    inputSchema: serviceIdOnlySchema,
    requiresConfirm: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (input, ctx) => {
      const { confirmToken, serviceid } = input as z.infer<typeof serviceIdOnlySchema> & {
        confirmToken?: string;
      };
      if (!confirmToken) {
        return {
          preview: true,
          data: { action: "ModuleChangePackage", serviceid },
          confirmToken: ctx.issueConfirmToken({
            tool: "services_module_change_package",
            serviceid,
          }),
        };
      }
      ctx.requireConfirmToken(confirmToken, {
        tool: "services_module_change_package",
        serviceid,
      });
      const result = await client.call("ModuleChangePackage", { serviceid });
      return { data: result };
    },
  });
}
