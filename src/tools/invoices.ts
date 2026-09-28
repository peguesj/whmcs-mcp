/**
 * src/tools/invoices.ts
 *
 * MCP tool registrations for the WHMCS "invoices" domain: `billing_*`
 * (invoices, credits, transactions, pay methods, billable items) and
 * `quotes_*`. Every tool maps 1:1 to a documented WHMCS External API action
 * (https://developers.whmcs.com/api-reference/) and is declared through the
 * shared `defineTool` helper in `./registry.js`, which is responsible for:
 *   - WHMCS_MCP_MODE / WHMCS_MCP_ENABLE_DOMAINS advertisement filtering
 *   - tier gating (read | write | billing | destructive)
 *   - dryRun short-circuiting for mutating tools (no network call, returns a preview)
 *   - the two-step confirmToken flow for "billing" and "destructive" tier tools
 *   - deep redaction of the WHMCS response (and error messages) before they
 *     reach the model
 *
 * This file owns every `toolList` entry from the architecture plan whose
 * `domain` is "invoices" (billing_* + quotes_*). Input schemas live in
 * `../schemas/invoices.js` and mirror WHMCS's documented per-action parameter
 * tables, including the line-item serialization helpers used below.
 *
 * OPERATOR POLICY NOTE (per the architecture plan and this repo's standing
 * rule that "invoices are operator-manual" -- no agent writes to WHMCS
 * invoices): every invoice-mutating tool here (`billing_create_invoice`,
 * `billing_update_invoice`, `billing_add_payment`, `billing_apply_credit`,
 * `billing_capture_payment`) is declared with `tier: "billing"`. Per
 * `src/config.ts`'s MODE_TIER_MATRIX, the "billing" tier is only advertised
 * when `WHMCS_MCP_MODE=full` -- it does not exist in the tool list under
 * "readonly" or "write" mode. Any 3VS deployment config must keep
 * `WHMCS_MCP_MODE` at "readonly" (the default) or, at most, "write"; setting
 * it to "full" is the single point where this policy could be violated and
 * must not be done for a 3VS/production deployment. See SECURITY.md.
 *
 * WHMCS auth/transport note: the WHMCS External API (/includes/api.php) is
 * NOT a generic REST-with-Bearer-token API. Authentication is a
 * form-encoded `identifier` + `secret` pair (optionally `accesskey`) in the
 * POST body, not an Authorization header. `whmcs-client.ts` is the single
 * place that constructs that request; this file never talks to the network
 * directly -- every handler below goes through `ctx.whmcs.call(...)`.
 */

import { unwrapCollection } from "../whmcs-client.js";
import { defineTool } from "./registry.js";
import type { ToolContext, ToolHandlerResult } from "./registry.js";

import {
  billingListInvoicesInputSchema,
  billingGetInvoiceInputSchema,
  billingCreateInvoiceInputSchema,
  billingUpdateInvoiceInputSchema,
  billingAddPaymentInputSchema,
  billingApplyCreditInputSchema,
  billingCapturePaymentInputSchema,
  billingAddCreditInputSchema,
  billingGetCreditsInputSchema,
  billingGetTransactionsInputSchema,
  billingAddBillableItemInputSchema,
  billingGetPayMethodsInputSchema,
  quotesListInputSchema,
  quotesCreateInputSchema,
  quotesUpdateInputSchema,
  quotesSendInputSchema,
  serializeInvoiceLineItems,
  serializeQuoteLineItems,
  type InvoiceLineItem,
} from "../schemas/invoices.js";

import type {
  InvoiceRaw,
  Invoice,
  InvoiceItemRaw,
  TransactionRaw,
  Transaction,
  WhmcsGetInvoicesRaw,
  WhmcsGetInvoiceRaw,
  WhmcsCreateInvoiceResult,
  WhmcsUpdateInvoiceResult,
  WhmcsAddInvoicePaymentResult,
  WhmcsApplyCreditResult,
  WhmcsCapturePaymentResult,
  WhmcsAddCreditResult,
  WhmcsGetCreditsRaw,
  CreditLogRaw,
  WhmcsGetTransactionsRaw,
  WhmcsAddBillableItemResult,
  WhmcsGetPayMethodsRaw,
  PayMethod,
  WhmcsGetQuotesRaw,
  QuoteRaw,
  Quote,
  QuoteLineItem as WhmcsQuoteLineItemRaw,
  WhmcsCreateQuoteResult,
  WhmcsUpdateQuoteResult,
  WhmcsSendQuoteResult,
} from "../types/whmcs.js";

/* ------------------------------------------------------------------ */
/* Normalization helpers (raw WHMCS wrapper shapes -> plain arrays)     */
/* ------------------------------------------------------------------ */

/** Flattens `InvoiceRaw.items`/`.transactions` collection wrappers into arrays. */
function normalizeInvoice(raw: InvoiceRaw): Invoice {
  return {
    ...raw,
    items: raw.items
      ? unwrapCollection<InvoiceItemRaw>(raw.items, "item")
      : undefined,
    transactions: raw.transactions
      ? unwrapCollection<TransactionRaw>(raw.transactions, "transaction")
      : undefined,
  };
}

/** Flattens `QuoteRaw.lineitems` into a plain array. */
function normalizeQuote(raw: QuoteRaw): Quote {
  return {
    ...raw,
    lineitems: raw.lineitems
      ? unwrapCollection<WhmcsQuoteLineItemRaw>(raw.lineitems, "lineitem")
      : undefined,
  };
}

/**
 * WHMCS's `UpdateInvoice` action appends *new* line items via
 * `newitemdescriptionN` / `newitemamountN` / `newitemtaxedN` (distinct from
 * `itemdescriptionN` etc., which target/replace *existing* rows by their
 * position/id). This mirrors `serializeInvoiceLineItems` from
 * `../schemas/invoices.js` but under the `newitem*` prefix WHMCS expects for
 * appended rows.
 */
function serializeNewInvoiceLineItems(
  items: readonly InvoiceLineItem[],
): Record<string, string> {
  const out: Record<string, string> = {};
  items.forEach((item, offset) => {
    const n = offset + 1;
    out[`newitemdescription${n}`] = item.description;
    out[`newitemamount${n}`] = item.amount;
    if (item.taxed !== undefined) {
      out[`newitemtaxed${n}`] = item.taxed ? "1" : "0";
    }
  });
  return out;
}

/**
 * WHMCS's documented mechanism for removing an existing invoice line item on
 * `UpdateInvoice` is to submit `deletelineid[]=<id>` entries. This is not a
 * flat scalar param (WhmcsCallParams only carries scalars), so we serialize
 * each id as its own indexed key (`deletelineid[0]`, `deletelineid[1]`, ...),
 * which `whmcs-client.ts` form-encodes like any other scalar field. If a
 * given WHMCS install expects the bare repeated-key form
 * (`deletelineid[]=1&deletelineid[]=2`) instead, this is the single place to
 * change the key format.
 */
function serializeDeleteLineIds(ids: readonly number[]): Record<string, string> {
  const out: Record<string, string> = {};
  ids.forEach((id, index) => {
    out[`deletelineid[${index}]`] = String(id);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* billing_* tools -> WHMCS Invoice / Credit / Transaction actions      */
/* ------------------------------------------------------------------ */

defineTool({
  name: "billing_list_invoices",
  domain: "invoices",
  tier: "read",
  whmcsAction: "GetInvoices",
  description: "List invoices, optionally filtered by client or status.",
  inputSchema: billingListInvoicesInputSchema,
  annotations: {
    title: "List invoices",
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsGetInvoicesRaw>("GetInvoices", {
      userid: input.userid,
      status: input.status,
      limitstart: input.limitstart,
      limitnum: input.limitnum,
      orderby: input.orderby,
      order: input.order,
    });
    const invoices = unwrapCollection<InvoiceRaw>(raw, "invoice").map(normalizeInvoice);
    return {
      data: {
        invoices,
        totalresults: raw.totalresults,
        startnumber: raw.startnumber,
        numreturned: raw.numreturned,
      },
      summary: `Found ${invoices.length} invoice(s).`,
    };
  },
});

defineTool({
  name: "billing_get_invoice",
  domain: "invoices",
  tier: "read",
  whmcsAction: "GetInvoice",
  description: "Get a single invoice by id, including its line items, transactions, and balance.",
  inputSchema: billingGetInvoiceInputSchema,
  annotations: {
    title: "Get invoice detail",
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsGetInvoiceRaw>("GetInvoice", {
      invoiceid: input.invoiceid,
    });
    const invoice = normalizeInvoice(raw);
    return {
      data: invoice,
      summary: `Invoice #${invoice.invoicenum ?? invoice.invoiceid}: ${invoice.status}, balance ${
        invoice.balance ?? "?"
      }.`,
    };
  },
});

defineTool({
  name: "billing_create_invoice",
  domain: "invoices",
  tier: "billing",
  whmcsAction: "CreateInvoice",
  description:
    "Create a new invoice for a client with one or more line items. OPERATOR POLICY: " +
    "invoices are operator-manual; this tool only exists when WHMCS_MCP_MODE=full and " +
    "must remain disabled in 3VS deployments (see SECURITY.md).",
  inputSchema: billingCreateInvoiceInputSchema,
  annotations: {
    title: "Create invoice",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  buildConfirmationPreview: (input) =>
    `Create a ${input.status ?? "Unpaid"} invoice for client #${input.userid} with ` +
    `${input.items.length} line item(s)` +
    (input.sendinvoice ? ", and email it to the client immediately" : "") +
    ".",
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsCreateInvoiceResult>("CreateInvoice", {
      userid: input.userid,
      status: input.status,
      draft: input.draft,
      sendinvoice: input.sendinvoice,
      paymentmethod: input.paymentmethod,
      taxrate: input.taxrate,
      date: input.date,
      duedate: input.duedate,
      notes: input.notes,
      ...serializeInvoiceLineItems(input.items),
    });
    return {
      data: { invoiceid: raw.invoiceid },
      summary: `Created invoice #${raw.invoiceid}.`,
    };
  },
});

defineTool({
  name: "billing_update_invoice",
  domain: "invoices",
  tier: "billing",
  whmcsAction: "UpdateInvoice",
  description:
    "Update an existing invoice's status, dates, notes, or line items. OPERATOR POLICY: " +
    "invoices are operator-manual; this tool only exists when WHMCS_MCP_MODE=full and " +
    "must remain disabled in 3VS deployments (see SECURITY.md).",
  inputSchema: billingUpdateInvoiceInputSchema,
  annotations: {
    title: "Update invoice",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  buildConfirmationPreview: (input) =>
    `Update invoice #${input.invoiceid}` +
    (input.status ? ` (status -> ${input.status})` : "") +
    (input.publish || input.publishandsendemail ? ", publishing it" : "") +
    (input.publishandsendemail ? " and emailing the client" : "") +
    ".",
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsUpdateInvoiceResult>("UpdateInvoice", {
      invoiceid: input.invoiceid,
      status: input.status,
      paymentmethod: input.paymentmethod,
      date: input.date,
      duedate: input.duedate,
      datepaid: input.datepaid,
      notes: input.notes,
      publish: input.publish,
      publishandsendemail: input.publishandsendemail,
      ...(input.items ? serializeInvoiceLineItems(input.items) : {}),
      ...(input.newitems ? serializeNewInvoiceLineItems(input.newitems) : {}),
      ...(input.deletelineids ? serializeDeleteLineIds(input.deletelineids) : {}),
    });
    return {
      data: raw,
      summary: `Updated invoice #${input.invoiceid}.`,
    };
  },
});

defineTool({
  name: "billing_add_payment",
  domain: "invoices",
  tier: "billing",
  whmcsAction: "AddInvoicePayment",
  description:
    "Record a payment against an invoice (marks it paid if the amount covers the balance).",
  inputSchema: billingAddPaymentInputSchema,
  annotations: {
    title: "Add invoice payment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  buildConfirmationPreview: (input) =>
    `Record a payment of ${input.amount ?? "the full balance"} on invoice #${input.invoiceid} ` +
    `via gateway "${input.gateway}" (transaction ${input.transid}).`,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsAddInvoicePaymentResult>("AddInvoicePayment", {
      invoiceid: input.invoiceid,
      transid: input.transid,
      gateway: input.gateway,
      amount: input.amount,
      fees: input.fees,
      date: input.date,
      noemail: input.noemail,
    });
    return {
      data: raw,
      summary: `Recorded payment on invoice #${input.invoiceid}.`,
    };
  },
});

defineTool({
  name: "billing_apply_credit",
  domain: "invoices",
  tier: "billing",
  whmcsAction: "ApplyCredit",
  description: "Apply client account credit balance to an invoice.",
  inputSchema: billingApplyCreditInputSchema,
  annotations: {
    title: "Apply credit to invoice",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  buildConfirmationPreview: (input) =>
    `Apply ${input.amount === "full" ? "the full available" : input.amount} credit to invoice #${
      input.invoiceid
    }.`,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsApplyCreditResult>("ApplyCredit", {
      invoiceid: input.invoiceid,
      amount: input.amount,
      noemail: input.noemail,
    });
    return {
      data: raw,
      summary: `Applied credit to invoice #${input.invoiceid}.`,
    };
  },
});

defineTool({
  name: "billing_capture_payment",
  domain: "invoices",
  tier: "billing",
  whmcsAction: "CapturePayment",
  description:
    "Attempt to capture payment for an invoice using the client's stored payment method. " +
    "`cvv`, if provided, is never logged or echoed back (see src/safety/redact.ts).",
  inputSchema: billingCapturePaymentInputSchema,
  annotations: {
    title: "Capture invoice payment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  buildConfirmationPreview: (input) =>
    `Attempt to capture payment for invoice #${input.invoiceid} using the client's stored ` +
    `payment method. This will attempt to charge the client.`,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsCapturePaymentResult>("CapturePayment", {
      invoiceid: input.invoiceid,
      cvv: input.cvv,
    });
    return {
      // cvv is never included here; redactDeep in the registry is defense
      // in depth on top of the fact that we simply never put it in `data`.
      data: { transactionId: raw.transactionId, amount: raw.amount, result: raw.result },
      summary: `Capture attempted for invoice #${input.invoiceid}.`,
    };
  },
});

defineTool({
  name: "billing_add_credit",
  domain: "invoices",
  tier: "billing",
  whmcsAction: "AddCredit",
  description: "Add (or remove) account credit for a client.",
  inputSchema: billingAddCreditInputSchema,
  annotations: {
    title: "Add/remove client credit",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  buildConfirmationPreview: (input) =>
    `${input.type === "remove" ? "Remove" : "Add"} ${input.amount} credit ${
      input.type === "remove" ? "from" : "to"
    } client #${input.clientid}: "${input.description}".`,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsAddCreditResult>("AddCredit", {
      clientid: input.clientid,
      description: input.description,
      amount: input.amount,
      date: input.date,
      adminid: input.adminid,
      type: input.type,
    });
    return {
      data: raw,
      summary: `${input.type === "remove" ? "Removed" : "Added"} credit for client #${input.clientid}.`,
    };
  },
});

defineTool({
  name: "billing_get_credits",
  domain: "invoices",
  tier: "read",
  whmcsAction: "GetCredits",
  description: "Get a client's current credit balance and credit log.",
  inputSchema: billingGetCreditsInputSchema,
  annotations: {
    title: "Get client credit balance/log",
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsGetCreditsRaw>("GetCredits", {
      clientid: input.clientid,
    });
    const creditlog = unwrapCollection<CreditLogRaw>(raw, "creditlog");
    return {
      data: { credit: raw.credit, creditlog },
      summary: `Client #${input.clientid} credit balance: ${raw.credit ?? "0.00"}.`,
    };
  },
});

defineTool({
  name: "billing_get_transactions",
  domain: "invoices",
  tier: "read",
  whmcsAction: "GetTransactions",
  description: "List gateway transactions, optionally filtered by invoice, client, or transaction id.",
  inputSchema: billingGetTransactionsInputSchema,
  annotations: {
    title: "List transactions",
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsGetTransactionsRaw>("GetTransactions", {
      invoiceid: input.invoiceid,
      clientid: input.clientid,
      transid: input.transid,
    });
    const transactions = unwrapCollection<TransactionRaw>(raw, "transactions") as Transaction[];
    return {
      data: { transactions, numreturned: raw.numreturned, totalresults: raw.totalresults },
      summary: `Found ${transactions.length} transaction(s).`,
    };
  },
});

defineTool({
  name: "billing_add_billable_item",
  domain: "invoices",
  tier: "billing",
  whmcsAction: "AddBillableItem",
  description:
    "Add a one-off or recurring billable line item for a client, to be invoiced per `invoiceaction`.",
  inputSchema: billingAddBillableItemInputSchema,
  annotations: {
    title: "Add billable item",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  buildConfirmationPreview: (input) =>
    `Add a billable item for client #${input.clientid}: "${input.description}" (${input.amount})` +
    (input.invoiceaction ? `, invoiceaction=${input.invoiceaction}` : "") +
    ".",
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsAddBillableItemResult>("AddBillableItem", {
      clientid: input.clientid,
      description: input.description,
      amount: input.amount,
      invoiceaction: input.invoiceaction,
      recur: input.recur,
      recurcycle: input.recurcycle,
      recurfor: input.recurfor,
      duedate: input.duedate,
      hours: input.hours,
    });
    return {
      data: { itemid: raw.itemid, invoiceid: raw.invoiceid },
      summary: `Added billable item for client #${input.clientid}.`,
    };
  },
});

defineTool({
  name: "billing_get_pay_methods",
  domain: "invoices",
  tier: "read",
  whmcsAction: "GetPayMethods",
  description:
    "List a client's stored payment methods. Card/bank account numbers are masked by WHMCS " +
    "and are additionally redacted server-side as defense in depth; raw PANs never reach the model.",
  inputSchema: billingGetPayMethodsInputSchema,
  annotations: {
    title: "List client payment methods",
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsGetPayMethodsRaw>("GetPayMethods", {
      clientid: input.clientid,
      paymethodid: input.paymethodid,
      type: input.type,
    });
    const paymethods = unwrapCollection<PayMethod>(raw, "paymethods");
    return {
      data: { paymethods },
      summary: `Found ${paymethods.length} payment method(s) for client #${input.clientid}.`,
    };
  },
});

/* ------------------------------------------------------------------ */
/* quotes_* tools -> WHMCS Quote actions                                */
/* ------------------------------------------------------------------ */

defineTool({
  name: "quotes_list",
  domain: "invoices",
  tier: "read",
  whmcsAction: "GetQuotes",
  description: "List quotes, optionally filtered by client, subject, or stage.",
  inputSchema: quotesListInputSchema,
  annotations: {
    title: "List quotes",
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsGetQuotesRaw>("GetQuotes", {
      quoteid: input.quoteid,
      userid: input.userid,
      subject: input.subject,
      stage: input.stage,
      datecreated: input.datecreated,
      lastmodified: input.lastmodified,
      validuntil: input.validuntil,
      limitstart: input.limitstart,
      limitnum: input.limitnum,
    });
    const quotes = unwrapCollection<QuoteRaw>(raw, "quotes").map(normalizeQuote);
    return {
      data: { quotes, totalresults: raw.totalresults },
      summary: `Found ${quotes.length} quote(s).`,
    };
  },
});

defineTool({
  name: "quotes_create",
  domain: "invoices",
  tier: "billing",
  whmcsAction: "CreateQuote",
  description:
    "Create a new quote for an existing client or a prospect, with one or more line items.",
  inputSchema: quotesCreateInputSchema,
  annotations: {
    title: "Create quote",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  buildConfirmationPreview: (input) =>
    `Create a "${input.stage}" quote "${input.subject}" for ` +
    (input.userid ? `client #${input.userid}` : `prospect ${input.prospect?.email ?? "(unknown)"}`) +
    ` with ${input.lineitems.length} line item(s), valid until ${input.validuntil}.`,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsCreateQuoteResult>("CreateQuote", {
      userid: input.userid,
      firstname: input.prospect?.firstname,
      lastname: input.prospect?.lastname,
      email: input.prospect?.email,
      companyname: input.prospect?.companyname,
      subject: input.subject,
      stage: input.stage,
      validuntil: input.validuntil,
      proposal: input.proposal,
      customernotes: input.customernotes,
      adminnotes: input.adminnotes,
      // WHMCS's CreateQuote/UpdateQuote accept `lineitems` as a JSON-encoded
      // array (not the flat itemN convention used by CreateInvoice), per
      // serializeQuoteLineItems' documentation in ../schemas/invoices.ts.
      lineitems: JSON.stringify(serializeQuoteLineItems(input.lineitems)),
    });
    return {
      data: { quoteid: raw.quoteid },
      summary: `Created quote #${raw.quoteid}: "${input.subject}".`,
    };
  },
});

defineTool({
  name: "quotes_update",
  domain: "invoices",
  tier: "billing",
  whmcsAction: "UpdateQuote",
  description: "Update an existing quote's subject, stage, line items, or notes.",
  inputSchema: quotesUpdateInputSchema,
  annotations: {
    title: "Update quote",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  buildConfirmationPreview: (input) =>
    `Update quote #${input.quoteid}` + (input.stage ? ` (stage -> ${input.stage})` : "") + ".",
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsUpdateQuoteResult>("UpdateQuote", {
      quoteid: input.quoteid,
      userid: input.userid,
      firstname: input.prospect?.firstname,
      lastname: input.prospect?.lastname,
      email: input.prospect?.email,
      companyname: input.prospect?.companyname,
      subject: input.subject,
      stage: input.stage,
      validuntil: input.validuntil,
      proposal: input.proposal,
      customernotes: input.customernotes,
      adminnotes: input.adminnotes,
      lineitems: input.lineitems ? JSON.stringify(serializeQuoteLineItems(input.lineitems)) : undefined,
    });
    return {
      data: raw,
      summary: `Updated quote #${input.quoteid}.`,
    };
  },
});

defineTool({
  name: "quotes_send",
  domain: "invoices",
  tier: "write",
  whmcsAction: "SendQuote",
  description: "Email an existing quote to its client/prospect.",
  inputSchema: quotesSendInputSchema,
  annotations: {
    title: "Send quote",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  buildConfirmationPreview: (input) => `Email quote #${input.quoteid} to its client/prospect.`,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsSendQuoteResult>("SendQuote", {
      quoteid: input.quoteid,
    });
    return {
      data: raw,
      summary: `Sent quote #${input.quoteid}.`,
    };
  },
});
