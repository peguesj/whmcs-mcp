/**
 * src/schemas/system.ts
 *
 * Zod input schemas for the `system` domain tools (src/tools/system.ts) plus the
 * `whmcs_raw_call` escape-hatch allowlist.
 *
 * Domain scope (per the architecture plan's toolList, entries with domain "system"):
 *   - system_get_details        -> WHMCS action WhmcsDetails
 *   - system_get_stats          -> WHMCS action GetStats
 *   - system_get_activity_log   -> WHMCS action GetActivityLog
 *   - system_get_admin_details  -> WHMCS action GetAdminDetails
 *   - system_get_todo_items     -> WHMCS action GetToDoItems
 *   - system_get_email_templates-> WHMCS action GetEmailTemplates
 *   - system_send_email         -> WHMCS action SendEmail
 *   - system_get_payment_methods-> WHMCS action GetPaymentMethods
 *   - system_get_currencies     -> WHMCS action GetCurrencies
 *   - system_log_activity       -> WHMCS action LogActivity
 *   - whmcs_raw_call            -> any documented 8.x/9.x action (full mode only)
 *
 * Auth note (see src/whmcs-client.ts, the only network boundary): WHMCS's
 * *External* API (POST {WHMCS_API_URL}/includes/api.php, form-encoded body,
 * responsetype=json) authenticates with `identifier` + `secret` (API
 * Credentials) plus an optional `accesskey`, NOT a Bearer/Authorization
 * header. That is confirmed against developers.whmcs.com/api-reference and is
 * unchanged across 8.12.x and 9.0.x. If a future WHMCS release moves to a
 * header-based scheme, the single point of change is the AUTH_STRATEGY
 * constant documented in src/whmcs-client.ts -- nothing in this schemas file
 * encodes transport/auth, only per-tool input shape.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared building blocks (kept local to this file; src/schemas/common.ts owns
// the cross-domain versions used by other tool modules).
// ---------------------------------------------------------------------------

/** WHMCS pagination: limitstart is a zero-based offset, limitnum is capped at 250. */
const limitstart = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Zero-based offset into the result set.");

const limitnum = z
  .number()
  .int()
  .min(1)
  .max(250)
  .optional()
  .describe("Max rows to return (WHMCS caps this at 250).");

/** YYYY-MM-DD, as WHMCS date-only params expect. */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .describe("Date in YYYY-MM-DD format.");

/** dryRun is accepted by every mutating tool; when true, no network call is made. */
const dryRun = z
  .boolean()
  .optional()
  .default(false)
  .describe("When true, validate and preview only -- no request is sent to WHMCS.");

/**
 * confirmToken is required on the second call of any billing/destructive tool's
 * two-step confirm flow (see src/safety/confirm.ts). system_send_email and
 * system_log_activity are `write` tier, not `billing`/`destructive`, so they do
 * not require it, but the field is accepted (and ignored) for forward
 * compatibility if policy.ts ever reclassifies a system tool upward.
 */
const confirmToken = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Short-lived token returned by a prior preview call; echo it back to execute.",
  );

const customvars = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .optional()
  .describe(
    "Extra template merge variables, e.g. {invoiceid} placeholders used by custom email templates.",
  );

// ---------------------------------------------------------------------------
// system_get_details -> WhmcsDetails
// ---------------------------------------------------------------------------

/** No inputs. Returns whmcs.version -- used for runtime version discovery/compat checks. */
export const systemGetDetailsSchema = z.object({}).strict();
export type SystemGetDetailsInput = z.infer<typeof systemGetDetailsSchema>;

// ---------------------------------------------------------------------------
// system_get_stats -> GetStats
// ---------------------------------------------------------------------------

export const systemGetStatsSchema = z
  .object({
    timeline_days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("Number of days back to include in the returned timeline stats."),
  })
  .strict();
export type SystemGetStatsInput = z.infer<typeof systemGetStatsSchema>;

// ---------------------------------------------------------------------------
// system_get_activity_log -> GetActivityLog
// ---------------------------------------------------------------------------

export const systemGetActivityLogSchema = z
  .object({
    limitstart,
    limitnum,
    clientid: z.number().int().positive().optional(),
    date: dateOnly.optional(),
    user: z.string().optional().describe("Admin username that logged the activity."),
    description: z
      .string()
      .optional()
      .describe("Substring filter against the activity log description."),
    ipaddress: z.string().optional(),
  })
  .strict();
export type SystemGetActivityLogInput = z.infer<typeof systemGetActivityLogSchema>;

// ---------------------------------------------------------------------------
// system_get_admin_details -> GetAdminDetails
// ---------------------------------------------------------------------------

/**
 * No inputs. Returns the identity/permissions of the admin the API
 * credentials resolve to. Redaction (src/safety/redact.ts) strips anything
 * secret-shaped before this reaches the model.
 */
export const systemGetAdminDetailsSchema = z.object({}).strict();
export type SystemGetAdminDetailsInput = z.infer<typeof systemGetAdminDetailsSchema>;

// ---------------------------------------------------------------------------
// system_get_todo_items -> GetToDoItems
// ---------------------------------------------------------------------------

export const systemGetTodoItemsSchema = z
  .object({
    status: z.enum(["Incomplete", "Completed"]).optional(),
    limitstart,
    limitnum,
  })
  .strict();
export type SystemGetTodoItemsInput = z.infer<typeof systemGetTodoItemsSchema>;

// ---------------------------------------------------------------------------
// system_get_email_templates -> GetEmailTemplates
// ---------------------------------------------------------------------------

export const systemGetEmailTemplatesSchema = z
  .object({
    type: z
      .enum(["general", "product", "domain", "invoice", "support", "affiliate"])
      .optional(),
    language: z
      .string()
      .optional()
      .describe("Locale code, e.g. 'english'; WHMCS falls back to the default language."),
  })
  .strict();
export type SystemGetEmailTemplatesInput = z.infer<typeof systemGetEmailTemplatesSchema>;

// ---------------------------------------------------------------------------
// system_send_email -> SendEmail  [write, confirm]
// ---------------------------------------------------------------------------

/**
 * WHMCS's SendEmail action takes either a pre-defined `messagename` (looked up
 * against GetEmailTemplates) or a `customtype` + `customsubject` +
 * `custommessage` triple for an ad hoc send. `id` is the related entity id
 * (clientid, invoiceid, ticketid, etc., depending on messagename/customtype).
 */
const sendEmailBase = z.object({
  id: z
    .number()
    .int()
    .positive()
    .describe("Related entity id (client, invoice, ticket, ...) the template applies to."),
  customvars,
  dryRun,
  confirmToken,
});

export const systemSendEmailSchema = z
  .discriminatedUnion("mode", [
    sendEmailBase.extend({
      mode: z.literal("template"),
      messagename: z.string().min(1),
    }),
    sendEmailBase.extend({
      mode: z.literal("custom"),
      customtype: z.string().min(1),
      customsubject: z.string().min(1),
      custommessage: z.string().min(1),
    }),
  ])
  .describe(
    "Send a templated email (mode='template', messagename) or an ad hoc one (mode='custom').",
  );
export type SystemSendEmailInput = z.infer<typeof systemSendEmailSchema>;

// ---------------------------------------------------------------------------
// system_get_payment_methods -> GetPaymentMethods
// ---------------------------------------------------------------------------

export const systemGetPaymentMethodsSchema = z.object({}).strict();
export type SystemGetPaymentMethodsInput = z.infer<typeof systemGetPaymentMethodsSchema>;

// ---------------------------------------------------------------------------
// system_get_currencies -> GetCurrencies
// ---------------------------------------------------------------------------

export const systemGetCurrenciesSchema = z.object({}).strict();
export type SystemGetCurrenciesInput = z.infer<typeof systemGetCurrenciesSchema>;

// ---------------------------------------------------------------------------
// system_log_activity -> LogActivity  [write]
// ---------------------------------------------------------------------------

export const systemLogActivitySchema = z
  .object({
    description: z.string().min(1).max(64000),
    clientid: z.number().int().positive().optional(),
    dryRun,
  })
  .strict();
export type SystemLogActivityInput = z.infer<typeof systemLogActivitySchema>;

// ---------------------------------------------------------------------------
// whmcs_raw_call -> <any documented action>  [full mode only, confirm]
// ---------------------------------------------------------------------------

/**
 * Bundled allowlist of documented WHMCS 8.x/9.x External API action names.
 * This is a safety boundary, not a convenience list: whmcs_raw_call rejects
 * any action not present here even when WHMCS_MCP_MODE=full, so an unknown or
 * newly introduced action must be added deliberately (and reviewed) rather
 * than silently reachable. Every action already covered by a typed tool above
 * is included too, since whmcs_raw_call is meant as an escape hatch alongside
 * them, not a way to bypass their schemas for the same action.
 */
export const WHMCS_RAW_CALL_ALLOWLIST = [
  // System
  "WhmcsDetails",
  "GetStats",
  "GetActivityLog",
  "GetAdminDetails",
  "GetToDoItems",
  "GetEmailTemplates",
  "SendEmail",
  "GetPaymentMethods",
  "GetCurrencies",
  "LogActivity",
  // Support tickets
  "GetTickets",
  "GetTicket",
  "OpenTicket",
  "AddTicketReply",
  "AddTicketNote",
  "GetTicketNotes",
  "UpdateTicket",
  "UpdateTicketReply",
  "MergeTicket",
  "DeleteTicket",
  "GetTicketAttachment",
  "GetTicketCounts",
  "GetSupportDepartments",
  "GetSupportStatuses",
  "GetTicketPredefinedReplies",
  // Clients
  "GetClients",
  "GetClientsDetails",
  "AddClient",
  "UpdateClient",
  "CloseClient",
  "GetContacts",
  "AddContact",
  "UpdateContact",
  "GetEmails",
  "GetClientGroups",
  // Products / services
  "GetClientsProducts",
  "GetClientsAddons",
  "GetProducts",
  "GetPromotions",
  "UpdateClientProduct",
  "UpdateClientAddon",
  "UpgradeProduct",
  "ModuleCreate",
  "ModuleSuspend",
  "ModuleUnsuspend",
  "ModuleTerminate",
  "ModuleChangePackage",
  // Invoices / billing
  "GetInvoices",
  "GetInvoice",
  "CreateInvoice",
  "UpdateInvoice",
  "AddInvoicePayment",
  "ApplyCredit",
  "CapturePayment",
  "AddCredit",
  "GetCredits",
  "GetTransactions",
  "AddBillableItem",
  "GetPayMethods",
  "GetQuotes",
  "CreateQuote",
  "UpdateQuote",
  "SendQuote",
  // Domains
  "GetClientsDomains",
  "DomainWhois",
  "DomainGetNameservers",
  "DomainUpdateNameservers",
  "DomainGetLockingStatus",
  "DomainUpdateLockingStatus",
  "DomainGetWhoisInfo",
  "UpdateClientDomain",
  "DomainRenew",
  "DomainRegister",
  "DomainTransfer",
  "GetTLDPricing",
  // Orders
  "GetOrders",
  "GetOrderStatuses",
  "AddOrder",
  "AcceptOrder",
  "PendingOrder",
  "CancelOrder",
  "FraudOrder",
  "DeleteOrder",
] as const;

export const whmcsRawCallActionSchema = z.enum(WHMCS_RAW_CALL_ALLOWLIST);

export const whmcsRawCallSchema = z
  .object({
    action: whmcsRawCallActionSchema.describe(
      "Documented WHMCS External API action name; validated against the bundled allowlist.",
    ),
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .default({})
      .describe(
        "Raw action parameters exactly as WHMCS documents them for `action` (form-encoded on the wire).",
      ),
    dryRun,
    confirmToken,
  })
  .strict()
  .describe(
    "Escape hatch for documented actions without a typed tool. Full mode only; billing/destructive actions still require confirmToken.",
  );
export type WhmcsRawCallInput = z.infer<typeof whmcsRawCallSchema>;
