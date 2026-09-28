/**
 * src/schemas/clients.ts
 *
 * Zod input schemas for every `clients_*` MCP tool.
 *
 * Domain ownership: this file owns every toolList entry whose `domain` is
 * "clients" in the architecture plan — i.e. WHMCS client/contact record
 * management. It deliberately does NOT own `clients_get_services` /
 * `clients_get_addons` (those are `domain: "products"`, see
 * src/schemas/products.ts) even though their tool names start with
 * `clients_`.
 *
 * Each schema mirrors the documented parameters for the corresponding
 * WHMCS External API action (see developers.whmcs.com/api-reference),
 * verified against both the 8.12.x and 9.0.x contract (unchanged for
 * every action below). The actual HTTP call, auth header construction,
 * and response normalization live in src/whmcs-client.ts — this file is
 * schema-only and performs no I/O.
 *
 * Tiers (see src/safety/policy.ts for the mode matrix):
 *   read        - clients_list, clients_get, clients_get_contacts,
 *                 clients_get_emails, clients_get_groups
 *   write       - clients_create, clients_update, clients_add_contact,
 *                 clients_update_contact
 *   destructive - clients_close (irreversible account closure; confirm-gated)
 */

import { z } from "zod";

import {
  clientIdSchema,
  confirmTokenSchema,
  dryRunSchema,
  emailSchema,
  iso2CountrySchema,
  limitNumSchema,
  limitStartSchema,
  nonEmptyStringSchema,
  sortDirectionSchema,
} from "./common.js";

/* -------------------------------------------------------------------------
 * clients_list -> WHMCS action: GetClients
 * ---------------------------------------------------------------------- */

/**
 * WHMCS `GetClients` documented status values. WHMCS treats this as a
 * free-form string in practice, but these three are the only values the
 * admin UI itself produces, so we validate against them and fall back to
 * `z.string()` leniency is intentionally NOT provided — an invalid status
 * should fail fast client-side rather than silently return an empty set.
 */
export const clientStatusSchema = z.enum(["Active", "Inactive", "Closed"]);

export const clientsListInputSchema = z.object({
  /** Free-text search across name, email, company, etc. */
  search: z.string().trim().min(1).optional(),
  status: clientStatusSchema.optional(),
  limitstart: limitStartSchema.optional(),
  limitnum: limitNumSchema.optional(),
  /** Column to sort by, e.g. "id", "firstname", "email", "signupdate". */
  orderby: z.string().trim().min(1).optional(),
  sorting: sortDirectionSchema.optional(),
});
export type ClientsListInput = z.infer<typeof clientsListInputSchema>;

/* -------------------------------------------------------------------------
 * clients_get -> WHMCS action: GetClientsDetails
 * ---------------------------------------------------------------------- */

export const clientsGetInputSchema = z
  .object({
    clientid: clientIdSchema.optional(),
    email: emailSchema.optional(),
    /** Include service/domain/invoice/ticket counts and financial stats. */
    stats: z.boolean().optional(),
  })
  .refine((v) => v.clientid !== undefined || v.email !== undefined, {
    message: "Provide either clientid or email to identify the client.",
    path: ["clientid"],
  });
export type ClientsGetInput = z.infer<typeof clientsGetInputSchema>;

/* -------------------------------------------------------------------------
 * clients_create -> WHMCS action: AddClient
 * ---------------------------------------------------------------------- */

export const clientsCreateInputSchema = z.object({
  firstname: nonEmptyStringSchema,
  lastname: nonEmptyStringSchema,
  email: emailSchema,
  address1: nonEmptyStringSchema,
  city: nonEmptyStringSchema,
  state: nonEmptyStringSchema,
  postcode: nonEmptyStringSchema,
  /** ISO 3166-1 alpha-2 country code, e.g. "US". WHMCS rejects other formats. */
  country: iso2CountrySchema,
  phonenumber: nonEmptyStringSchema,
  companyname: z.string().trim().optional(),
  /** 3-letter currency code understood by the WHMCS install, e.g. "USD". */
  currency: z.string().trim().length(3).toUpperCase().optional(),
  groupid: z.number().int().positive().optional(),
  /** WHMCS admin-area language/locale identifier, e.g. "english". */
  language: z.string().trim().min(1).optional(),
  /**
   * Custom client field values. WHMCS's raw API expects
   * `customfields<base64(fieldname)>` = value; the WHMCS client
   * serializes this map at the transport layer.
   */
  customfields: z.record(z.string(), z.string()).optional(),
  /** Skip WHMCS's built-in address/phone validation. */
  skipvalidation: z.boolean().optional(),
  /** Suppress the "New Account" welcome email. */
  noemail: z.boolean().optional(),
  dryRun: dryRunSchema,
});
export type ClientsCreateInput = z.infer<typeof clientsCreateInputSchema>;

/* -------------------------------------------------------------------------
 * clients_update -> WHMCS action: UpdateClient
 * ---------------------------------------------------------------------- */

export const clientsUpdateInputSchema = z
  .object({
    clientid: clientIdSchema.optional(),
    /** Alternate identifier WHMCS accepts in place of clientid. */
    clientemail: emailSchema.optional(),
    firstname: z.string().trim().min(1).optional(),
    lastname: z.string().trim().min(1).optional(),
    companyname: z.string().trim().optional(),
    email: emailSchema.optional(),
    address1: z.string().trim().min(1).optional(),
    address2: z.string().trim().optional(),
    city: z.string().trim().min(1).optional(),
    state: z.string().trim().min(1).optional(),
    postcode: z.string().trim().min(1).optional(),
    country: iso2CountrySchema.optional(),
    phonenumber: z.string().trim().min(1).optional(),
    status: clientStatusSchema.optional(),
    notes: z.string().optional(),
    groupid: z.number().int().positive().optional(),
    /**
     * Account credit balance, as a decimal string (WHMCS money fields are
     * transmitted as strings to avoid floating-point rounding, e.g.
     * "25.00"). This SETS the balance; it does not add/subtract — for
     * incremental credit changes use billing_add_credit instead.
     */
    credit: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/, "credit must be a decimal string like \"25.00\"")
      .optional(),
    /** Remove any stored credit-card/paymethod token on file. */
    clearcreditcard: z.boolean().optional(),
    customfields: z.record(z.string(), z.string()).optional(),
    dryRun: dryRunSchema,
  })
  .refine((v) => v.clientid !== undefined || v.clientemail !== undefined, {
    message: "Provide either clientid or clientemail to identify the client.",
    path: ["clientid"],
  });
export type ClientsUpdateInput = z.infer<typeof clientsUpdateInputSchema>;

/* -------------------------------------------------------------------------
 * clients_close -> WHMCS action: CloseClient  [destructive, confirm-gated]
 * ---------------------------------------------------------------------- */

export const clientsCloseInputSchema = z.object({
  clientid: clientIdSchema,
  /**
   * Two-step confirmation token from src/safety/confirm.ts. Omitted on the
   * first (preview) call; required, and must match the hash of this same
   * tool+args pair, on the executing call. See src/safety/confirm.ts for
   * the HMAC/TTL scheme.
   */
  confirmToken: confirmTokenSchema.optional(),
});
export type ClientsCloseInput = z.infer<typeof clientsCloseInputSchema>;

/* -------------------------------------------------------------------------
 * clients_get_contacts -> WHMCS action: GetContacts
 * ---------------------------------------------------------------------- */

export const clientsGetContactsInputSchema = z.object({
  /** WHMCS calls the owning client's id "userid" on this action. */
  userid: clientIdSchema.optional(),
  firstname: z.string().trim().min(1).optional(),
  lastname: z.string().trim().min(1).optional(),
  email: emailSchema.optional(),
  limitstart: limitStartSchema.optional(),
  limitnum: limitNumSchema.optional(),
});
export type ClientsGetContactsInput = z.infer<typeof clientsGetContactsInputSchema>;

/* -------------------------------------------------------------------------
 * clients_add_contact -> WHMCS action: AddContact
 * ---------------------------------------------------------------------- */

/**
 * WHMCS sub-account/contact permission flags. Passed as a single
 * comma-separated string on the wire (e.g. "General,Domains,Products");
 * modeled here as a typed array and joined by the transport layer.
 */
export const contactPermissionSchema = z.enum([
  "General",
  "Products/Services",
  "Domains",
  "Billing",
  "Support",
  "Emails",
  "Affiliates",
]);

export const clientsAddContactInputSchema = z.object({
  clientid: clientIdSchema,
  firstname: nonEmptyStringSchema,
  lastname: nonEmptyStringSchema,
  email: emailSchema,
  phonenumber: z.string().trim().optional(),
  permissions: z.array(contactPermissionSchema).optional(),
  /** Per-contact email subscription preferences (WHMCS boolean fields). */
  emailoptin_general: z.boolean().optional(),
  emailoptin_products: z.boolean().optional(),
  emailoptin_domains: z.boolean().optional(),
  emailoptin_invoices: z.boolean().optional(),
  emailoptin_support: z.boolean().optional(),
  emailoptin_affiliates: z.boolean().optional(),
});
export type ClientsAddContactInput = z.infer<typeof clientsAddContactInputSchema>;

/* -------------------------------------------------------------------------
 * clients_update_contact -> WHMCS action: UpdateContact
 * ---------------------------------------------------------------------- */

export const clientsUpdateContactInputSchema = z.object({
  contactid: z.number().int().positive(),
  firstname: z.string().trim().min(1).optional(),
  lastname: z.string().trim().min(1).optional(),
  email: emailSchema.optional(),
  phonenumber: z.string().trim().optional(),
  companyname: z.string().trim().optional(),
  address1: z.string().trim().optional(),
  address2: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  postcode: z.string().trim().optional(),
  country: iso2CountrySchema.optional(),
  permissions: z.array(contactPermissionSchema).optional(),
  emailoptin_general: z.boolean().optional(),
  emailoptin_products: z.boolean().optional(),
  emailoptin_domains: z.boolean().optional(),
  emailoptin_invoices: z.boolean().optional(),
  emailoptin_support: z.boolean().optional(),
  emailoptin_affiliates: z.boolean().optional(),
});
export type ClientsUpdateContactInput = z.infer<typeof clientsUpdateContactInputSchema>;

/* -------------------------------------------------------------------------
 * clients_get_emails -> WHMCS action: GetEmails
 * ---------------------------------------------------------------------- */

export const clientsGetEmailsInputSchema = z.object({
  clientid: clientIdSchema,
  /** Filter to emails sent on this date, format YYYY-MM-DD. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
  subject: z.string().trim().min(1).optional(),
  limitstart: limitStartSchema.optional(),
  limitnum: limitNumSchema.optional(),
});
export type ClientsGetEmailsInput = z.infer<typeof clientsGetEmailsInputSchema>;

/* -------------------------------------------------------------------------
 * clients_get_groups -> WHMCS action: GetClientGroups
 * ---------------------------------------------------------------------- */

export const clientsGetGroupsInputSchema = z.object({});
export type ClientsGetGroupsInput = z.infer<typeof clientsGetGroupsInputSchema>;
