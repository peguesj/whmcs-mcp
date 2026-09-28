/**
 * src/schemas/domains.ts
 *
 * Zod input schemas for every `domains_*` MCP tool (domain: "domains" in the
 * architecture plan's toolList), mirroring the documented parameters of the
 * corresponding WHMCS External API actions:
 *
 *   domains_list                 -> GetClientsDomains
 *   domains_whois_availability   -> DomainWhois
 *   domains_get_nameservers      -> DomainGetNameservers
 *   domains_update_nameservers   -> DomainUpdateNameservers
 *   domains_get_locking_status   -> DomainGetLockingStatus
 *   domains_update_locking_status-> DomainUpdateLockingStatus
 *   domains_get_whois_info       -> DomainGetWhoisInfo
 *   domains_update               -> UpdateClientDomain
 *   domains_renew                -> DomainRenew        [billing tier]
 *   domains_register             -> DomainRegister     [billing tier]
 *   domains_transfer             -> DomainTransfer     [billing tier]
 *   domains_get_tld_pricing      -> GetTLDPricing
 *
 * These schemas describe *tool input* only. The actual HTTP call (auth,
 * form-encoding, retries, error mapping) lives in ../whmcs-client.ts; this
 * file has no network code and performs no I/O.
 *
 * NOTE ON WHMCS AUTH (not used directly in this file, documented here since
 * several tools below carry auth-adjacent secrets like EPP codes):
 * The WHMCS External API (/includes/api.php) authenticates via POST body
 * fields `identifier` + `secret` (+ optional `accesskey`), NOT a REST-style
 * Authorization header. If a future revision of this server exposes a
 * REST-shaped transport in front of the External API, the exact header name
 * for any bridged Bearer-style auth should be kept as a single named
 * constant in whmcs-client.ts so it is a one-line fix; it is uncertain
 * whether WHMCS 8.x/9.x expose a native REST v1 surface distinct from the
 * documented External API, so this server targets the External API contract
 * exclusively (confirmed compatible with 8.12.x and 9.0.x per the plan).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives (kept local to this file; not yet factored into
// ./common.ts, which is owned by a different file in this plan)
// ---------------------------------------------------------------------------

/** WHMCS numeric identifiers are passed as strings or numbers; accept both, coerce to a positive int. */
const idSchema = z.coerce.number().int().positive();

/** Pagination shared by WHMCS list-style actions. WHMCS caps limitnum at 250. */
const limitstartSchema = z.coerce.number().int().min(0).optional();
const limitnumSchema = z.coerce.number().int().min(1).max(250).optional();

/** Dry-run flag on every mutating tool: when true, the tool validates input and returns a preview with no network call. */
const dryRunSchema = z
  .boolean()
  .optional()
  .describe(
    "When true, validate input and return a preview only; no WHMCS API call is made.",
  );

/**
 * Two-step confirmation token for billing/destructive-tier tools. The first
 * call (confirmToken omitted) returns a preview plus a short-lived,
 * single-use token; the second call must echo it back to proceed.
 */
const confirmTokenSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Echo the confirmToken returned by this tool's preview call to execute the action. Omit to receive a preview.",
  );

/** A bare domain name, e.g. "example.com". Loose validation; WHMCS is the source of truth. */
const domainNameSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i, {
    message: "Expected a domain name, e.g. example.com",
  });

/** WHMCS nameserver hostnames (ns1..ns5 in UpdateClientNameservers). */
const nameserverSchema = z.string().min(1).max(255);

// ---------------------------------------------------------------------------
// domains_list -> GetClientsDomains [read]
// ---------------------------------------------------------------------------

export const domainsListSchema = z.object({
  clientid: idSchema.optional(),
  domainid: idSchema.optional(),
  domain: domainNameSchema.optional(),
  limitstart: limitstartSchema,
  limitnum: limitnumSchema,
});
export type DomainsListInput = z.infer<typeof domainsListSchema>;

// ---------------------------------------------------------------------------
// domains_whois_availability -> DomainWhois [read]
// ---------------------------------------------------------------------------

export const domainsWhoisAvailabilitySchema = z.object({
  domain: domainNameSchema,
});
export type DomainsWhoisAvailabilityInput = z.infer<
  typeof domainsWhoisAvailabilitySchema
>;

// ---------------------------------------------------------------------------
// domains_get_nameservers -> DomainGetNameservers [read]
// ---------------------------------------------------------------------------

export const domainsGetNameserversSchema = z.object({
  domainid: idSchema,
});
export type DomainsGetNameserversInput = z.infer<
  typeof domainsGetNameserversSchema
>;

// ---------------------------------------------------------------------------
// domains_update_nameservers -> DomainUpdateNameservers [write, confirm]
// ---------------------------------------------------------------------------

export const domainsUpdateNameserversSchema = z
  .object({
    domainid: idSchema.optional(),
    domain: domainNameSchema.optional(),
    ns1: nameserverSchema,
    ns2: nameserverSchema,
    ns3: nameserverSchema.optional(),
    ns4: nameserverSchema.optional(),
    ns5: nameserverSchema.optional(),
    dryRun: dryRunSchema,
    confirmToken: confirmTokenSchema,
  })
  .refine((v) => v.domainid !== undefined || v.domain !== undefined, {
    message: "One of domainid or domain is required",
    path: ["domainid"],
  });
export type DomainsUpdateNameserversInput = z.infer<
  typeof domainsUpdateNameserversSchema
>;

// ---------------------------------------------------------------------------
// domains_get_locking_status -> DomainGetLockingStatus [read]
// ---------------------------------------------------------------------------

export const domainsGetLockingStatusSchema = z.object({
  domainid: idSchema,
});
export type DomainsGetLockingStatusInput = z.infer<
  typeof domainsGetLockingStatusSchema
>;

// ---------------------------------------------------------------------------
// domains_update_locking_status -> DomainUpdateLockingStatus [write, confirm]
// ---------------------------------------------------------------------------

export const domainsUpdateLockingStatusSchema = z.object({
  domainid: idSchema,
  lockstatus: z.boolean(),
  dryRun: dryRunSchema,
  confirmToken: confirmTokenSchema,
});
export type DomainsUpdateLockingStatusInput = z.infer<
  typeof domainsUpdateLockingStatusSchema
>;

// ---------------------------------------------------------------------------
// domains_get_whois_info -> DomainGetWhoisInfo [read]
// PII note: registrant contact fields in the response are subject to
// src/safety/redact.ts before reaching the model (see plan safety layer).
// ---------------------------------------------------------------------------

export const domainsGetWhoisInfoSchema = z.object({
  domainid: idSchema,
});
export type DomainsGetWhoisInfoInput = z.infer<
  typeof domainsGetWhoisInfoSchema
>;

// ---------------------------------------------------------------------------
// domains_update -> UpdateClientDomain [write]
// ---------------------------------------------------------------------------

const domainStatusSchema = z.enum([
  "Pending",
  "Active",
  "Expired",
  "Cancelled",
  "Fraud",
  "Transferred Away",
]);

export const domainsUpdateSchema = z.object({
  domainid: idSchema,
  status: domainStatusSchema.optional(),
  nextduedate: z.string().optional().describe("YYYY-MM-DD"),
  expirydate: z.string().optional().describe("YYYY-MM-DD"),
  regperiod: z.coerce.number().int().min(1).max(10).optional(),
  recurringamount: z.coerce.number().nonnegative().optional(),
  autorecalc: z.boolean().optional(),
  dnsmanagement: z.boolean().optional(),
  emailforwarding: z.boolean().optional(),
  idprotection: z.boolean().optional(),
  donotrenew: z.boolean().optional(),
  notes: z.string().optional(),
  dryRun: dryRunSchema,
});
export type DomainsUpdateInput = z.infer<typeof domainsUpdateSchema>;

// ---------------------------------------------------------------------------
// domains_renew -> DomainRenew [billing, confirm]
// Gated: only advertised when WHMCS_MCP_MODE=full (billing tier), per the
// operator's "invoices are operator-manual" policy noted in the plan.
// ---------------------------------------------------------------------------

export const domainsRenewSchema = z
  .object({
    domainid: idSchema.optional(),
    domain: domainNameSchema.optional(),
    regperiod: z.coerce.number().int().min(1).max(10).optional(),
    dryRun: dryRunSchema,
    confirmToken: confirmTokenSchema,
  })
  .refine((v) => v.domainid !== undefined || v.domain !== undefined, {
    message: "One of domainid or domain is required",
    path: ["domainid"],
  });
export type DomainsRenewInput = z.infer<typeof domainsRenewSchema>;

// ---------------------------------------------------------------------------
// domains_register -> DomainRegister [billing, confirm]
// ---------------------------------------------------------------------------

export const domainsRegisterSchema = z
  .object({
    domainid: idSchema.optional(),
    domain: domainNameSchema.optional(),
    idnlanguage: z.string().max(16).optional(),
    dryRun: dryRunSchema,
    confirmToken: confirmTokenSchema,
  })
  .refine((v) => v.domainid !== undefined || v.domain !== undefined, {
    message: "One of domainid or domain is required",
    path: ["domainid"],
  });
export type DomainsRegisterInput = z.infer<typeof domainsRegisterSchema>;

// ---------------------------------------------------------------------------
// domains_transfer -> DomainTransfer [billing, confirm]
// eppcode is a transfer secret: never logged; redaction applies to any error
// message or echoed payload (src/safety/redact.ts).
// ---------------------------------------------------------------------------

export const domainsTransferSchema = z
  .object({
    domainid: idSchema.optional(),
    domain: domainNameSchema.optional(),
    eppcode: z
      .string()
      .min(1)
      .optional()
      .describe("EPP/auth transfer code. Never logged; redacted from all output."),
    dryRun: dryRunSchema,
    confirmToken: confirmTokenSchema,
  })
  .refine((v) => v.domainid !== undefined || v.domain !== undefined, {
    message: "One of domainid or domain is required",
    path: ["domainid"],
  });
export type DomainsTransferInput = z.infer<typeof domainsTransferSchema>;

// ---------------------------------------------------------------------------
// domains_get_tld_pricing -> GetTLDPricing [read]
// ---------------------------------------------------------------------------

export const domainsGetTldPricingSchema = z.object({
  currencyid: idSchema.optional(),
  clientid: idSchema.optional(),
});
export type DomainsGetTldPricingInput = z.infer<
  typeof domainsGetTldPricingSchema
>;

// ---------------------------------------------------------------------------
// Aggregate export, consumed by src/tools/domains.ts when registering tools.
// ---------------------------------------------------------------------------

export const domainsSchemas = {
  domains_list: domainsListSchema,
  domains_whois_availability: domainsWhoisAvailabilitySchema,
  domains_get_nameservers: domainsGetNameserversSchema,
  domains_update_nameservers: domainsUpdateNameserversSchema,
  domains_get_locking_status: domainsGetLockingStatusSchema,
  domains_update_locking_status: domainsUpdateLockingStatusSchema,
  domains_get_whois_info: domainsGetWhoisInfoSchema,
  domains_update: domainsUpdateSchema,
  domains_renew: domainsRenewSchema,
  domains_register: domainsRegisterSchema,
  domains_transfer: domainsTransferSchema,
  domains_get_tld_pricing: domainsGetTldPricingSchema,
} as const;
