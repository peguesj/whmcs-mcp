/**
 * src/schemas/invoices.ts
 *
 * Zod input schemas for the `billing_*` and `quotes_*` MCP tools (domain: "invoices"),
 * mirroring the documented parameters of the WHMCS External API actions:
 *   GetInvoices, GetInvoice, CreateInvoice, UpdateInvoice, AddInvoicePayment,
 *   ApplyCredit, CapturePayment, AddCredit, GetCredits, GetTransactions,
 *   AddBillableItem, GetPayMethods, GetQuotes, CreateQuote, UpdateQuote, SendQuote.
 *
 * NOTE ON TRANSPORT/AUTH: per the architecture plan, the actual HTTP call lives in
 * src/whmcs-client.ts, which POSTs form-encoded bodies to `${WHMCS_API_URL}/includes/api.php`
 * using WHMCS's External API auth (identifier + secret [+ accesskey], responsetype=json) --
 * NOT a REST v1 Bearer scheme. If a future WHMCS REST v1 surface is targeted instead, the
 * auth header name/shape is a one-line constant in whmcs-client.ts (see AUTH_HEADER_NOTE
 * there) and does not require changes to these schemas, which only describe tool inputs.
 *
 * Every schema here is a *tool input* schema (what the MCP client sends us), not the raw
 * WHMCS wire format. Tools in src/tools/invoices.ts translate structured inputs (e.g. an
 * `items` array) into WHMCS's flat, index-suffixed form fields (e.g. itemdescription1,
 * itemamount1, itemtaxed1, ...) using the serialization helpers exported below.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
//
// These mirror what src/schemas/common.ts is expected to export (pagination,
// id, date/datetime, money, dryRun, confirmToken, sort enums). Duplicated
// locally with the same shape/semantics so this file has no load-bearing
// dependency ordering on common.ts; once common.ts lands, these local
// definitions can be replaced with re-exports from "./common.js" without
// changing any tool-facing schema shape.
// ---------------------------------------------------------------------------

/** WHMCS numeric entity id (invoiceid, clientid, userid, quoteid, ...). */
const idSchema = z.number().int().positive();

/** WHMCS pagination: limitstart (offset) + limitnum (page size, capped at 250 per docs). */
const paginationSchema = {
  limitstart: z.number().int().nonnegative().optional(),
  limitnum: z.number().int().positive().max(250).optional(),
};

/** WHMCS date, e.g. "2026-09-28". */
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

/** WHMCS datetime, e.g. "2026-09-28 14:30:00". */
const dateTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    "Expected YYYY-MM-DD HH:MM:SS",
  );

/**
 * WHMCS money amount as a decimal string (WHMCS itself is picky about trailing
 * zeros / locale formatting on some actions, so we keep this as a string and
 * let the tool layer normalize rather than lose precision through a JS number).
 */
const moneySchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "Expected a decimal amount like 12.50");

/** Every mutating tool accepts dryRun: true to preview without calling WHMCS. */
const dryRunSchema = z.boolean().optional().describe(
  "When true, validate and serialize the request but do not call the WHMCS API.",
);

/**
 * Two-step confirmation token for billing/destructive tiers (see
 * src/safety/confirm.ts). The first call omits this and gets a preview +
 * confirmToken back; the second call echoes it to actually execute.
 */
const confirmTokenSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Echo the confirmToken returned by a prior preview call of this same tool to execute the action.",
  );

const sortOrderSchema = z.enum(["ASC", "DESC"]);

// ---------------------------------------------------------------------------
// Line-item serialization helpers
//
// WHMCS's CreateInvoice/UpdateInvoice actions do not take a JSON array for
// line items; they take flat, 1-indexed fields: itemdescription1, itemamount1,
// itemtaxed1, itemdescription2, itemamount2, itemtaxed2, ... These helpers
// convert a typed array into that flat WHMCS param shape so every tool
// implementation does the same thing the same way.
// ---------------------------------------------------------------------------

/** One line item accepted by billing_create_invoice / billing_update_invoice (`newitems`). */
export const invoiceLineItemSchema = z.object({
  description: z.string().min(1),
  amount: moneySchema,
  taxed: z.boolean().optional(),
});
export type InvoiceLineItem = z.infer<typeof invoiceLineItemSchema>;

/**
 * Serializes an array of invoice line items into WHMCS's itemdescriptionN /
 * itemamountN / itemtaxedN flat param convention.
 *
 * @param items - line items in display order; WHMCS indexes from 1.
 * @param startIndex - first index to use (default 1); UpdateInvoice's
 *   `newitems` also starts from 1 per the documented API, but callers that
 *   need to append after existing rows can pass a higher start index.
 */
export function serializeInvoiceLineItems(
  items: readonly InvoiceLineItem[],
  startIndex = 1,
): Record<string, string> {
  const out: Record<string, string> = {};
  items.forEach((item, offset) => {
    const n = startIndex + offset;
    out[`itemdescription${n}`] = item.description;
    out[`itemamount${n}`] = item.amount;
    if (item.taxed !== undefined) {
      out[`itemtaxed${n}`] = item.taxed ? "1" : "0";
    }
  });
  return out;
}

/**
 * One quote line item, per WHMCS CreateQuote/UpdateQuote `lineitems` array
 * (desc, qty, up = unit price, discount, taxable). WHMCS's own API accepts
 * this as a JSON-encoded array under the `lineitems` field rather than flat
 * itemN fields (quotes and invoices serialize differently), so this helper
 * just normalizes/validates rather than flattening -- the tool layer
 * JSON.stringifies the result into the `lineitems` form field.
 */
export const quoteLineItemSchema = z.object({
  desc: z.string().min(1),
  qty: z.number().positive().default(1),
  up: moneySchema,
  discount: moneySchema.optional(),
  taxable: z.boolean().optional(),
});
export type QuoteLineItem = z.infer<typeof quoteLineItemSchema>;

/**
 * Normalizes quote line items into the plain-object array shape WHMCS expects
 * to receive as the JSON-encoded `lineitems` field value.
 */
export function serializeQuoteLineItems(
  items: readonly QuoteLineItem[],
): Array<Record<string, string | number | boolean>> {
  return items.map((item) => {
    const row: Record<string, string | number | boolean> = {
      desc: item.desc,
      qty: item.qty,
      up: item.up,
    };
    if (item.discount !== undefined) row.discount = item.discount;
    if (item.taxable !== undefined) row.taxable = item.taxable;
    return row;
  });
}

// ---------------------------------------------------------------------------
// billing_* tools -> WHMCS Invoice / Credit / Transaction actions
// ---------------------------------------------------------------------------

/** [read] GetInvoices */
export const billingListInvoicesInputSchema = z.object({
  userid: idSchema.optional(),
  status: z
    .enum([
      "Draft",
      "Unpaid",
      "Paid",
      "Cancelled",
      "Refunded",
      "Collections",
      "Overdue",
      "Payment Pending",
    ])
    .optional(),
  ...paginationSchema,
  orderby: z.string().optional(),
  order: sortOrderSchema.optional(),
});
export type BillingListInvoicesInput = z.infer<
  typeof billingListInvoicesInputSchema
>;

/** [read] GetInvoice */
export const billingGetInvoiceInputSchema = z.object({
  invoiceid: idSchema,
});
export type BillingGetInvoiceInput = z.infer<
  typeof billingGetInvoiceInputSchema
>;

/**
 * [billing, confirm; tool advertised only when WHMCS_MCP_MODE=full]
 * CreateInvoice
 *
 * Operator policy note: invoices are operator-manual (no agent writes to
 * WHMCS invoices). This tool exists in the schema/tool surface for
 * completeness and is gated behind the "billing" tier + full mode in
 * src/safety/policy.ts; it must remain disabled in any 3VS deployment
 * config per SECURITY.md.
 */
export const billingCreateInvoiceInputSchema = z.object({
  userid: idSchema,
  status: z.enum(["Draft", "Unpaid"]).optional(),
  draft: z.boolean().optional(),
  sendinvoice: z.boolean().optional(),
  paymentmethod: z.string().optional(),
  taxrate: z.number().nonnegative().optional(),
  date: dateSchema.optional(),
  duedate: dateSchema.optional(),
  notes: z.string().optional(),
  items: z.array(invoiceLineItemSchema).min(1),
  dryRun: dryRunSchema,
  confirmToken: confirmTokenSchema,
});
export type BillingCreateInvoiceInput = z.infer<
  typeof billingCreateInvoiceInputSchema
>;

/** [billing, confirm; full mode only] UpdateInvoice */
export const billingUpdateInvoiceInputSchema = z.object({
  invoiceid: idSchema,
  status: z
    .enum([
      "Draft",
      "Unpaid",
      "Paid",
      "Cancelled",
      "Refunded",
      "Collections",
      "Overdue",
      "Payment Pending",
    ])
    .optional(),
  paymentmethod: z.string().optional(),
  date: dateSchema.optional(),
  duedate: dateSchema.optional(),
  datepaid: dateTimeSchema.optional(),
  notes: z.string().optional(),
  /** Replaces existing itemdescriptionN/itemamountN/itemtaxedN rows in place. */
  items: z.array(invoiceLineItemSchema).optional(),
  /** Appended as new itemdescriptionN/itemamountN/itemtaxedN rows. */
  newitems: z.array(invoiceLineItemSchema).optional(),
  /** Line ids to remove from the invoice. */
  deletelineids: z.array(idSchema).optional(),
  publish: z.boolean().optional(),
  publishandsendemail: z.boolean().optional(),
  dryRun: dryRunSchema,
  confirmToken: confirmTokenSchema,
});
export type BillingUpdateInvoiceInput = z.infer<
  typeof billingUpdateInvoiceInputSchema
>;

/** [billing, confirm; full mode only] AddInvoicePayment */
export const billingAddPaymentInputSchema = z.object({
  invoiceid: idSchema,
  transid: z.string().min(1),
  gateway: z.string().min(1),
  amount: moneySchema.optional(),
  fees: moneySchema.optional(),
  date: dateTimeSchema.optional(),
  noemail: z.boolean().optional(),
  dryRun: dryRunSchema,
  confirmToken: confirmTokenSchema,
});
export type BillingAddPaymentInput = z.infer<
  typeof billingAddPaymentInputSchema
>;

/** [billing, confirm; full mode only] ApplyCredit */
export const billingApplyCreditInputSchema = z.object({
  invoiceid: idSchema,
  amount: z.union([moneySchema, z.literal("full")]),
  noemail: z.boolean().optional(),
  dryRun: dryRunSchema,
  confirmToken: confirmTokenSchema,
});
export type BillingApplyCreditInput = z.infer<
  typeof billingApplyCreditInputSchema
>;

/**
 * [billing, confirm; full mode only] CapturePayment
 *
 * `cvv` is intentionally never logged (see src/safety/redact.ts) and is
 * stripped from any structured tool result or error message.
 */
export const billingCapturePaymentInputSchema = z.object({
  invoiceid: idSchema,
  cvv: z.string().min(3).max(4).optional(),
  dryRun: dryRunSchema,
  confirmToken: confirmTokenSchema,
});
export type BillingCapturePaymentInput = z.infer<
  typeof billingCapturePaymentInputSchema
>;

/** [billing, confirm] AddCredit */
export const billingAddCreditInputSchema = z.object({
  clientid: idSchema,
  description: z.string().min(1),
  amount: moneySchema,
  date: dateSchema.optional(),
  adminid: idSchema.optional(),
  type: z.enum(["add", "remove"]).optional(),
  dryRun: dryRunSchema,
  confirmToken: confirmTokenSchema,
});
export type BillingAddCreditInput = z.infer<
  typeof billingAddCreditInputSchema
>;

/** [read] GetCredits */
export const billingGetCreditsInputSchema = z.object({
  clientid: idSchema,
});
export type BillingGetCreditsInput = z.infer<
  typeof billingGetCreditsInputSchema
>;

/** [read] GetTransactions */
export const billingGetTransactionsInputSchema = z.object({
  invoiceid: idSchema.optional(),
  clientid: idSchema.optional(),
  transid: z.string().optional(),
});
export type BillingGetTransactionsInput = z.infer<
  typeof billingGetTransactionsInputSchema
>;

/** [billing, confirm] AddBillableItem */
export const billingAddBillableItemInputSchema = z.object({
  clientid: idSchema,
  description: z.string().min(1),
  amount: moneySchema,
  invoiceaction: z
    .enum(["noinvoice", "nextcron", "nextinvoice", "duedate", "recur"])
    .optional(),
  recur: z.number().int().positive().optional(),
  recurcycle: z
    .enum(["Days", "Weeks", "Months", "Years"])
    .optional(),
  recurfor: z.number().int().positive().optional(),
  duedate: dateSchema.optional(),
  hours: z.number().positive().optional(),
  dryRun: dryRunSchema,
  confirmToken: confirmTokenSchema,
});
export type BillingAddBillableItemInput = z.infer<
  typeof billingAddBillableItemInputSchema
>;

/**
 * [read] GetPayMethods
 *
 * Card/bank account numbers are masked by WHMCS itself and are additionally
 * covered by src/safety/redact.ts as defense in depth; raw PANs must never
 * reach the model.
 */
export const billingGetPayMethodsInputSchema = z.object({
  clientid: idSchema,
  paymethodid: idSchema.optional(),
  type: z.enum(["BankAccount", "CreditCard"]).optional(),
});
export type BillingGetPayMethodsInput = z.infer<
  typeof billingGetPayMethodsInputSchema
>;

// ---------------------------------------------------------------------------
// quotes_* tools -> WHMCS Quote actions
// ---------------------------------------------------------------------------

const quoteStageSchema = z.enum([
  "Draft",
  "Delivered",
  "On Hold",
  "Accepted",
  "Lost",
  "Dead",
]);

/** [read] GetQuotes */
export const quotesListInputSchema = z.object({
  quoteid: idSchema.optional(),
  userid: idSchema.optional(),
  subject: z.string().optional(),
  stage: quoteStageSchema.optional(),
  datecreated: dateSchema.optional(),
  lastmodified: dateSchema.optional(),
  validuntil: dateSchema.optional(),
  ...paginationSchema,
});
export type QuotesListInput = z.infer<typeof quotesListInputSchema>;

/** Prospect fields accepted by CreateQuote when no existing userid is given. */
const quoteProspectSchema = z.object({
  firstname: z.string().min(1),
  lastname: z.string().min(1),
  email: z.string().email(),
  companyname: z.string().optional(),
});

const quoteBaseFields = {
  subject: z.string().min(1),
  stage: quoteStageSchema,
  validuntil: dateSchema,
  lineitems: z.array(quoteLineItemSchema).min(1),
  proposal: z.string().optional(),
  customernotes: z.string().optional(),
  adminnotes: z.string().optional(),
};

/** [billing, confirm] CreateQuote -- either an existing userid or prospect fields. */
export const quotesCreateInputSchema = z
  .object({
    userid: idSchema.optional(),
    prospect: quoteProspectSchema.optional(),
    ...quoteBaseFields,
    dryRun: dryRunSchema,
    confirmToken: confirmTokenSchema,
  })
  .refine((v) => v.userid !== undefined || v.prospect !== undefined, {
    message: "Either userid or prospect must be provided",
    path: ["userid"],
  });
export type QuotesCreateInput = z.infer<typeof quotesCreateInputSchema>;

/** [billing, confirm] UpdateQuote -- any CreateQuote field, targeted by quoteid. */
export const quotesUpdateInputSchema = z.object({
  quoteid: idSchema,
  userid: idSchema.optional(),
  prospect: quoteProspectSchema.optional(),
  subject: z.string().min(1).optional(),
  stage: quoteStageSchema.optional(),
  validuntil: dateSchema.optional(),
  lineitems: z.array(quoteLineItemSchema).min(1).optional(),
  proposal: z.string().optional(),
  customernotes: z.string().optional(),
  adminnotes: z.string().optional(),
  dryRun: dryRunSchema,
  confirmToken: confirmTokenSchema,
});
export type QuotesUpdateInput = z.infer<typeof quotesUpdateInputSchema>;

/** [write, confirm] SendQuote */
export const quotesSendInputSchema = z.object({
  quoteid: idSchema,
  dryRun: dryRunSchema,
  confirmToken: confirmTokenSchema,
});
export type QuotesSendInput = z.infer<typeof quotesSendInputSchema>;
