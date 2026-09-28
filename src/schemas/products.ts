/**
 * src/schemas/products.ts
 *
 * Zod input schemas for the "products" domain tools: product catalog reads,
 * client service/addon lookups, and client-service/addon mutations
 * (services_* + products_* + clients_get_services/addons per the architecture
 * plan's toolList). These mirror WHMCS's documented External API parameters
 * for each action 1:1 so src/tools/products.ts can build a defineTool()
 * registration per entry without re-deriving parameter shapes.
 *
 * WHMCS actions covered here (see docs/tools.md, generated from this file
 * via z.toJSONSchema):
 *   - GetClientsProducts   -> clients_get_services   [read]
 *   - GetClientsAddons     -> clients_get_addons      [read]
 *   - GetProducts          -> products_list           [read]
 *   - GetPromotions        -> products_get_promotions [read]
 *   - UpdateClientProduct  -> services_update             [write]
 *   - UpdateClientAddon    -> services_update_addon        [write]
 *   - UpgradeProduct       -> services_upgrade             [billing, confirm]
 *   - ModuleCreate         -> services_module_create        [write, confirm]
 *   - ModuleSuspend        -> services_module_suspend       [write, confirm]
 *   - ModuleUnsuspend      -> services_module_unsuspend     [write, confirm]
 *   - ModuleTerminate      -> services_module_terminate     [destructive, confirm]
 *   - ModuleChangePackage  -> services_module_change_package [write, confirm]
 *
 * NOTE ON TRANSPORT: these are pure zod *input* schemas. The actual HTTP call
 * (WHMCS External API: POST {WHMCS_API_URL}/includes/api.php, form-encoded,
 * identifier + secret [+ optional accesskey], responsetype=json) lives in
 * src/whmcs-client.ts, not here — see that file for the auth constant and its
 * uncertainty note. This file only shapes and validates what a tool call may
 * pass in before it is serialized to WHMCS's form fields.
 */

import { z } from "zod";
import {
  booleanish,
  confirmTokenField,
  dryRunField,
  idField,
  moneyDecimalString,
  paginationSchema,
} from "./common.js";

/* -------------------------------------------------------------------------
 * clients_get_services  ->  GetClientsProducts  [read]
 * ---------------------------------------------------------------------- */

export const clientsGetServicesInputSchema = z
  .object({
    clientid: idField.optional().describe("Filter to a single client's services."),
    serviceid: idField.optional().describe("Return a single service by its ID."),
    pid: idField.optional().describe("Filter by product/package ID."),
    domain: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe("Filter by the service's associated domain."),
    username2: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe("Filter by the service's module username (WHMCS parameter name)."),
  })
  .merge(paginationSchema)
  .describe(
    "[read] GetClientsProducts — list or fetch client services. Service module " +
      "passwords are redacted by src/safety/redact.ts before results reach the model.",
  );

export type ClientsGetServicesInput = z.infer<typeof clientsGetServicesInputSchema>;

/* -------------------------------------------------------------------------
 * clients_get_addons  ->  GetClientsAddons  [read]
 * ---------------------------------------------------------------------- */

export const clientsGetAddonsInputSchema = z
  .object({
    clientid: idField.optional().describe("Filter to a single client's addons."),
    serviceid: idField.optional().describe("Filter to addons attached to one service."),
    addonid: idField.optional().describe("Return a single client addon by its ID."),
  })
  .describe("[read] GetClientsAddons — list a client's, or a service's, product addons.");

export type ClientsGetAddonsInput = z.infer<typeof clientsGetAddonsInputSchema>;

/* -------------------------------------------------------------------------
 * products_list  ->  GetProducts  [read]
 * ---------------------------------------------------------------------- */

/**
 * WHMCS accepts a single pid or a comma-separated list ("pid" param is
 * documented as int|csv). We accept either a single id, an array of ids
 * (joined to CSV before the WHMCS call in the client), or a raw CSV string,
 * and normalize downstream in src/tools/products.ts.
 */
const pidFilter = z
  .union([idField, z.array(idField).min(1).max(100), z.string().regex(/^\d+(,\d+)*$/)])
  .optional()
  .describe("A single product ID, an array of IDs, or a WHMCS-style CSV string.");

export const productsListInputSchema = z
  .object({
    pid: pidFilter,
    gid: idField.optional().describe("Filter by product group ID."),
    module: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Filter by the provisioning module name (e.g. 'cpanel', 'noserver')."),
  })
  .describe("[read] GetProducts — list products/packages, optionally filtered.");

export type ProductsListInput = z.infer<typeof productsListInputSchema>;

/* -------------------------------------------------------------------------
 * products_get_promotions  ->  GetPromotions  [read]
 * ---------------------------------------------------------------------- */

export const productsGetPromotionsInputSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .optional()
      .describe("Return a single promotion/coupon by its code."),
  })
  .describe("[read] GetPromotions — list active promotions, or fetch one by code.");

export type ProductsGetPromotionsInput = z.infer<typeof productsGetPromotionsInputSchema>;

/* -------------------------------------------------------------------------
 * services_update  ->  UpdateClientProduct  [write]
 * ---------------------------------------------------------------------- */

/**
 * WHMCS serializes per-config-option values as configoptionN / configoptionN
 * value pairs and custom fields as customfieldN[id]=value in the raw API
 * call; the tool layer accepts a typed record/array here and does that
 * serialization in src/tools/products.ts, keeping the WHMCS wire format out
 * of the public zod schema.
 */
const configOptionsSchema = z
  .array(
    z.object({
      optionId: idField.describe("WHMCS configurable option ID."),
      optionValue: z
        .union([z.string().max(500), z.number(), idField])
        .describe("Selected option value, sub-option ID, or quantity."),
    }),
  )
  .max(50)
  .optional()
  .describe("Configurable option selections to apply to the service.");

const customFieldsSchema = z
  .record(z.string().min(1).max(100), z.string().max(2000))
  .optional()
  .describe("Custom field id/name -> value map.");

export const servicesUpdateInputSchema = z
  .object({
    serviceid: idField.describe("The client service (hosting/product) to update."),
    pid: idField.optional().describe("Change the service to a different product ID."),
    status: z
      .enum(["Active", "Suspended", "Terminated", "Cancelled", "Fraud", "Pending"])
      .optional()
      .describe("New service status."),
    nextduedate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
      .optional()
      .describe("Next due date (YYYY-MM-DD)."),
    billingcycle: z
      .enum([
        "Free Account",
        "One Time",
        "Monthly",
        "Quarterly",
        "Semi-Annually",
        "Annually",
        "Biennially",
        "Triennially",
      ])
      .optional()
      .describe("New billing cycle."),
    recurringamount: moneyDecimalString.optional().describe("Override recurring amount."),
    domain: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe("Associated domain for the service."),
    notes: z.string().max(10_000).optional().describe("Admin notes on the service."),
    customfields: customFieldsSchema,
    configoptions: configOptionsSchema,
    dryRun: dryRunField,
  })
  .describe(
    "[write] UpdateClientProduct — update a client's service record (status, dates, " +
      "billing, config options, notes). Does not itself run provisioning module " +
      "actions; pair with services_module_* for that.",
  );

export type ServicesUpdateInput = z.infer<typeof servicesUpdateInputSchema>;

/* -------------------------------------------------------------------------
 * services_update_addon  ->  UpdateClientAddon  [write]
 * ---------------------------------------------------------------------- */

export const servicesUpdateAddonInputSchema = z
  .object({
    id: idField.describe("The client addon record ID (not the addon/product ID)."),
    status: z
      .enum(["Pending", "Active", "Terminated", "Cancelled", "Fraud"])
      .optional()
      .describe("New addon status."),
    addonid: idField.optional().describe("Reassign to a different addon/product ID."),
    name: z.string().trim().min(1).max(255).optional().describe("Override the addon's display name."),
    setupfee: moneyDecimalString.optional().describe("Override the one-time setup fee."),
    recurring: moneyDecimalString.optional().describe("Override the recurring amount."),
    billingcycle: z
      .enum([
        "Free Account",
        "One Time",
        "Monthly",
        "Quarterly",
        "Semi-Annually",
        "Annually",
        "Biennially",
        "Triennially",
      ])
      .optional()
      .describe("New billing cycle for the addon."),
    nextduedate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
      .optional()
      .describe("Next due date (YYYY-MM-DD)."),
    notes: z.string().max(10_000).optional().describe("Admin notes on the addon."),
  })
  .describe("[write] UpdateClientAddon — update a client product addon's billing/status/notes.");

export type ServicesUpdateAddonInput = z.infer<typeof servicesUpdateAddonInputSchema>;

/* -------------------------------------------------------------------------
 * services_upgrade  ->  UpgradeProduct  [billing, confirm]
 * ---------------------------------------------------------------------- */

export const servicesUpgradeInputSchema = z
  .object({
    serviceid: idField.describe("The client service to upgrade/downgrade."),
    type: z
      .enum(["product", "configoptions"])
      .describe("Whether this changes the product/package itself or only config options."),
    newproductid: idField
      .optional()
      .describe("Target product ID when type=product."),
    newproductbillingcycle: z
      .enum([
        "Free Account",
        "One Time",
        "Monthly",
        "Quarterly",
        "Semi-Annually",
        "Annually",
        "Biennially",
        "Triennially",
      ])
      .optional()
      .describe("Target billing cycle when type=product."),
    configoptions: configOptionsSchema,
    paymentmethod: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .describe("Payment gateway module name to invoice the upgrade order against."),
    promocode: z.string().trim().max(50).optional().describe("Promo/coupon code to apply."),
    /**
     * WHMCS's calconly=true path prices the upgrade without committing it —
     * this is the built-in preview mechanism the plan's two-step billing
     * confirmation flow (src/safety/confirm.ts) wraps: the first tool call
     * runs with calconly=true (or dryRun) to produce a priced preview and a
     * confirmToken, and only the confirmed second call may omit it.
     */
    calconly: booleanish
      .optional()
      .describe("Price-only preview; WHMCS performs no upgrade when true."),
    confirmToken: confirmTokenField,
    dryRun: dryRunField,
  })
  .describe(
    "[billing, confirm] UpgradeProduct — change a service's product/package or " +
      "config options, generating an upgrade order/invoice. Billing-tier: only " +
      "advertised when WHMCS_MCP_MODE=full. The confirm flow's preview step should " +
      "run with calconly=true.",
  );

export type ServicesUpgradeInput = z.infer<typeof servicesUpgradeInputSchema>;

/* -------------------------------------------------------------------------
 * services_module_create  ->  ModuleCreate  [write, confirm]
 * ---------------------------------------------------------------------- */

export const servicesModuleCreateInputSchema = z
  .object({
    serviceid: idField.describe("The client service to provision via its module command."),
    confirmToken: confirmTokenField,
    dryRun: dryRunField,
  })
  .describe(
    "[write, confirm] ModuleCreate — run the provisioning module's create/setup " +
      "action for an existing service record.",
  );

export type ServicesModuleCreateInput = z.infer<typeof servicesModuleCreateInputSchema>;

/* -------------------------------------------------------------------------
 * services_module_suspend  ->  ModuleSuspend  [write, confirm]
 * ---------------------------------------------------------------------- */

export const servicesModuleSuspendInputSchema = z
  .object({
    serviceid: idField.describe("The client service to suspend via its module."),
    suspendreason: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .describe("Reason recorded against the suspension, shown to staff/client per template."),
    confirmToken: confirmTokenField,
    dryRun: dryRunField,
  })
  .describe("[write, confirm] ModuleSuspend — run the provisioning module's suspend action.");

export type ServicesModuleSuspendInput = z.infer<typeof servicesModuleSuspendInputSchema>;

/* -------------------------------------------------------------------------
 * services_module_unsuspend  ->  ModuleUnsuspend  [write, confirm]
 * ---------------------------------------------------------------------- */

export const servicesModuleUnsuspendInputSchema = z
  .object({
    serviceid: idField.describe("The client service to unsuspend via its module."),
    confirmToken: confirmTokenField,
    dryRun: dryRunField,
  })
  .describe("[write, confirm] ModuleUnsuspend — run the provisioning module's unsuspend action.");

export type ServicesModuleUnsuspendInput = z.infer<typeof servicesModuleUnsuspendInputSchema>;

/* -------------------------------------------------------------------------
 * services_module_terminate  ->  ModuleTerminate  [destructive, confirm]
 * ---------------------------------------------------------------------- */

export const servicesModuleTerminateInputSchema = z
  .object({
    serviceid: idField.describe("The client service to terminate via its module."),
    confirmToken: confirmTokenField,
    dryRun: dryRunField,
  })
  .describe(
    "[destructive, confirm] ModuleTerminate — run the provisioning module's " +
      "terminate action. Irreversible at the module/remote-resource level; " +
      "requires a fresh confirmToken every call (single-use, 5 min TTL).",
  );

export type ServicesModuleTerminateInput = z.infer<typeof servicesModuleTerminateInputSchema>;

/* -------------------------------------------------------------------------
 * services_module_change_package  ->  ModuleChangePackage  [write, confirm]
 * ---------------------------------------------------------------------- */

export const servicesModuleChangePackageInputSchema = z
  .object({
    serviceid: idField.describe(
      "The client service to re-provision on its module after a product/config change.",
    ),
    confirmToken: confirmTokenField,
    dryRun: dryRunField,
  })
  .describe(
    "[write, confirm] ModuleChangePackage — run the provisioning module's change-" +
      "package action, typically after services_update or services_upgrade has " +
      "already changed the WHMCS-side product/config values.",
  );

export type ServicesModuleChangePackageInput = z.infer<
  typeof servicesModuleChangePackageInputSchema
>;
