/**
 * src/schemas/common.ts
 *
 * Shared zod building blocks used across every tool-domain schema file
 * (tickets, clients, invoices, products, domains, orders, system).
 *
 * These mirror the WHMCS External API's documented parameter conventions:
 *  - `limitstart` / `limitnum` pagination, capped at 250 per WHMCS's own
 *    hard ceiling on list-style actions (GetTickets, GetClients, GetInvoices, ...).
 *  - WHMCS numeric IDs (clientid, ticketid, invoiceid, serviceid, ...) are
 *    always positive integers in the API, never strings.
 *  - WHMCS date/datetime fields are plain strings in the API payload
 *    (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`); we validate shape but pass
 *    them through as strings rather than coercing to `Date`, since the
 *    wire format WHMCS expects back is the same string.
 *  - Money fields (amount, recurringamount, setupfee, ...) are accepted as
 *    either a number or a decimal string and normalized to a fixed-point
 *    decimal string before being form-encoded to WHMCS.
 *  - `dryRun` is an MCP-server-local safety flag (never sent to WHMCS): when
 *    true, a write/billing/destructive tool must validate + serialize its
 *    WHMCS params and return a preview without making the network call.
 *  - `confirmToken` is the MCP-server-local two-step confirmation token
 *    (see src/safety/confirm.ts) required on the second call to any
 *    billing- or destructive-tier tool.
 */

import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Pagination                                                          */
/* ------------------------------------------------------------------ */

/** WHMCS hard caps most list actions at 250 results per page (limitnum). */
export const MAX_LIMIT_NUM = 250;

export const limitstartSchema = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Zero-based offset into the result set (WHMCS `limitstart`).");

export const limitnumSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT_NUM)
  .optional()
  .describe(
    `Maximum rows to return, capped at ${String(MAX_LIMIT_NUM)} (WHMCS \`limitnum\`).`,
  );

/** Spread into any list-style tool's input schema shape. */
export const paginationFields = {
  limitstart: limitstartSchema,
  limitnum: limitnumSchema,
} as const;

export const paginationSchema = z.object(paginationFields);

/* ------------------------------------------------------------------ */
/* IDs                                                                  */
/* ------------------------------------------------------------------ */

/** Any WHMCS primary-key style integer id (clientid, ticketid, invoiceid, ...). */
export const idSchema = z.number().int().positive();

/** Comma-separated list of ids as WHMCS accepts for some filters (e.g. pid csv). */
export const idCsvSchema = z
  .string()
  .regex(/^\d+(,\d+)*$/, "Expected a comma-separated list of positive integers");

/* ------------------------------------------------------------------ */
/* Dates                                                                */
/* ------------------------------------------------------------------ */

/** WHMCS date-only fields, e.g. nextduedate, duedate: `YYYY-MM-DD`. */
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .describe("Date string in WHMCS's `YYYY-MM-DD` format.");

/** WHMCS datetime fields, e.g. ticket `created`: `YYYY-MM-DD HH:MM:SS`. */
export const datetimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    "Expected YYYY-MM-DD HH:MM:SS",
  )
  .describe("Datetime string in WHMCS's `YYYY-MM-DD HH:MM:SS` format.");

/** Accepts either shape when a WHMCS action documents `date` loosely. */
export const dateOrDatetimeSchema = z.union([dateSchema, datetimeSchema]);

/* ------------------------------------------------------------------ */
/* Money                                                                */
/* ------------------------------------------------------------------ */

/**
 * WHMCS money fields (amount, recurringamount, setupfee, taxrate, ...) are
 * form-encoded as decimal strings. We accept a number or a numeric string
 * from the caller and normalize downstream; this schema only validates
 * shape (finite, non-negative unless the action explicitly allows credits/
 * negative adjustments — callers needing negative amounts should use
 * `signedMoneySchema` instead).
 */
export const moneySchema = z
  .union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d{1,2})?$/)])
  .describe("Decimal amount, e.g. 19.99. Accepts a number or a numeric string.");

/** For fields that may legitimately be negative (e.g. AddCredit type=remove flows). */
export const signedMoneySchema = z
  .union([z.number(), z.string().regex(/^-?\d+(\.\d{1,2})?$/)])
  .describe("Decimal amount, may be negative. Accepts a number or a numeric string.");

/**
 * Normalizes a `moneySchema`/`signedMoneySchema` value to a fixed 2-decimal
 * string suitable for form-encoding to the WHMCS API.
 */
export function toMoneyString(value: number | string): string {
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) {
    throw new TypeError(`Invalid money value: ${String(value)}`);
  }
  return n.toFixed(2);
}

/* ------------------------------------------------------------------ */
/* Safety-layer fields (MCP-server-local; never sent to WHMCS)         */
/* ------------------------------------------------------------------ */

export const dryRunSchema = z
  .boolean()
  .optional()
  .default(false)
  .describe(
    "MCP-local only. When true, validates and serializes the WHMCS request " +
      "and returns a preview without calling the WHMCS API.",
  );

export const confirmTokenSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "MCP-local only. Required on the second call to a billing- or " +
      "destructive-tier tool: the short-lived, single-use token returned " +
      "by that tool's first (preview) call. See src/safety/confirm.ts.",
  );

/** Spread into any billing/destructive tool's input schema shape. */
export const confirmFields = {
  dryRun: dryRunSchema,
  confirmToken: confirmTokenSchema,
} as const;

/* ------------------------------------------------------------------ */
/* Sorting                                                              */
/* ------------------------------------------------------------------ */

export const sortOrderSchema = z.enum(["ASC", "DESC"]);

/** Generic `orderby` field: WHMCS accepts the target column name as a string. */
export const orderBySchema = z.string().min(1).optional();

export const sortingFields = {
  orderby: orderBySchema,
  sorting: sortOrderSchema.optional(),
} as const;

/* ------------------------------------------------------------------ */
/* Booleans as WHMCS expects them                                       */
/* ------------------------------------------------------------------ */

/**
 * Several WHMCS actions accept boolean-ish flags as "true"/"false" strings
 * or 1/0 rather than native booleans in the form-encoded body. Tools accept
 * a native boolean here; the WHMCS client is responsible for serializing it
 * to whatever string form the specific action expects.
 */
export const boolFlagSchema = z.boolean().optional();

/* ------------------------------------------------------------------ */
/* Misc shared enums                                                    */
/* ------------------------------------------------------------------ */

export const markdownFlagSchema = z
  .boolean()
  .optional()
  .describe("Whether the message body is Markdown-formatted (WHMCS `markdown`).");

export const noEmailFlagSchema = z
  .boolean()
  .optional()
  .describe("Suppress the client-facing notification email for this action.");

/* ------------------------------------------------------------------ */
/* Aliases                                                              */
/*                                                                      */
/* Several domain schema files (clients.ts, products.ts, ...) reference */
/* these names directly. Kept as aliases of the canonical schemas above */
/* so there is exactly one source of truth per concept.                */
/* ------------------------------------------------------------------ */

/** Alias of `idSchema`, used where a domain file names it semantically. */
export const clientIdSchema = idSchema;

/** Alias of `idSchema`, used by the products/services domain. */
export const idField = idSchema;

export const emailSchema = z.string().trim().pipe(z.email());

export const iso2CountrySchema = z
  .string()
  .trim()
  .length(2)
  .toUpperCase()
  .describe("ISO 3166-1 alpha-2 country code, e.g. US.");

/** Alias of `limitnumSchema`. */
export const limitNumSchema = limitnumSchema;

/** Alias of `limitstartSchema`. */
export const limitStartSchema = limitstartSchema;

export const nonEmptyStringSchema = z.string().trim().min(1);

/** Alias of `sortOrderSchema`. */
export const sortDirectionSchema = sortOrderSchema;

/**
 * Several WHMCS actions accept a "1"/"0"/true/false-ish flag. Accepts a
 * native boolean from the caller; the WHMCS client serializes it downstream.
 */
export const booleanish = z.boolean();

/** Alias of `confirmTokenSchema`, named for products/services domain usage. */
export const confirmTokenField = confirmTokenSchema;

/** Alias of `dryRunSchema`, named for products/services domain usage. */
export const dryRunField = dryRunSchema;

/** Decimal money value serialized as a string, e.g. "19.99". */
export const moneyDecimalString = moneySchema;
