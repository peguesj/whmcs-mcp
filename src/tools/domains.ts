/**
 * src/tools/domains.ts
 *
 * Registers every `domains_*` MCP tool (the "domains" tool domain from the
 * architecture plan's toolList) against the shared WHMCS External API
 * client. Covers: listing a client's domains, WHOIS availability lookup,
 * nameserver read/update, registrar-lock read/update, WHOIS contact info
 * (PII-sensitive), the domain record itself (status/renewal flags/notes),
 * and the three registrar-billing actions (renew, register, transfer).
 *
 *   domains_list                  -> GetClientsDomains          [read]
 *   domains_whois_availability    -> DomainWhois                [read]
 *   domains_get_nameservers       -> DomainGetNameservers        [read]
 *   domains_update_nameservers    -> DomainUpdateNameservers     [write, confirm]
 *   domains_get_locking_status    -> DomainGetLockingStatus      [read]
 *   domains_update_locking_status -> DomainUpdateLockingStatus   [write, confirm]
 *   domains_get_whois_info        -> DomainGetWhoisInfo          [read, PII]
 *   domains_update                -> UpdateClientDomain          [write]
 *   domains_renew                 -> DomainRenew                 [billing, confirm]
 *   domains_register              -> DomainRegister              [billing, confirm]
 *   domains_transfer              -> DomainTransfer              [billing, confirm]
 *   domains_get_tld_pricing       -> GetTLDPricing                [read]
 *
 * Registration/tier/mode gating, dryRun short-circuiting, the two-step
 * confirm-token flow, and output redaction are all handled centrally by
 * `defineTool` (src/tools/registry.ts) and `src/safety/redact.ts` — this
 * file only shapes each tool's WHMCS param mapping and any domain-specific
 * masking that the shared redaction layer does not already cover (the
 * WHOIS Registrant/Admin/Technical/Billing contact blocks below, and the
 * eppcode-in-error-message scrub for domains_transfer).
 */

import { defineTool, type ToolContext, type ToolHandlerResult } from "./registry.js";
import {
  domainsListSchema,
  domainsWhoisAvailabilitySchema,
  domainsGetNameserversSchema,
  domainsUpdateNameserversSchema,
  domainsGetLockingStatusSchema,
  domainsUpdateLockingStatusSchema,
  domainsGetWhoisInfoSchema,
  domainsUpdateSchema,
  domainsRenewSchema,
  domainsRegisterSchema,
  domainsTransferSchema,
  domainsGetTldPricingSchema,
} from "../schemas/domains.js";
import { unwrapCollection } from "../whmcs-client.js";
import type {
  DomainRaw,
  WhmcsGetClientsDomainsRaw,
  WhmcsDomainWhoisInfoResult,
  WhmcsGetTLDPricingRaw,
} from "../types/whmcs.js";

// ---------------------------------------------------------------------------
// Domain-specific PII masking (WHOIS contact blocks) — not covered by the
// shared redaction layer, which does not know WHMCS's per-contact-block
// shape. See file header NOTE ON REDACTION.
// ---------------------------------------------------------------------------

const WHOIS_PII_KEY_PATTERN =
  /email|phone|telephone|fax|address|street|postalcode|postcode|zip/i;

/**
 * Masks likely-PII fields inside each WHOIS contact block (Registrant,
 * Admin, Technical, Billing) when `redactPii` is enabled. Organization and
 * country are left intact since they are usually the registrar/registrant
 * business identity rather than an individual's personal data, and are
 * useful for triage; everything else matching a contact-PII key is masked.
 */
function redactWhoisContacts(
  result: WhmcsDomainWhoisInfoResult,
  redactPii: boolean,
): WhmcsDomainWhoisInfoResult {
  if (!redactPii) return result;
  const blocks = ["Registrant", "Admin", "Technical", "Billing"] as const;
  const redacted: WhmcsDomainWhoisInfoResult = { ...result };
  for (const block of blocks) {
    const contact = redacted[block];
    if (!contact || typeof contact !== "object") continue;
    const maskedContact: Record<string, string> = {};
    for (const [key, value] of Object.entries(contact)) {
      maskedContact[key] = WHOIS_PII_KEY_PATTERN.test(key) ? "[REDACTED]" : value;
    }
    redacted[block] = maskedContact;
  }
  return redacted;
}

/**
 * WHMCS boolean-ish fields (lockstatus, autorecalc, dnsmanagement, ...) are
 * sent as "1"/"0", never true/false. Accepts `unknown` defensively since
 * these values flow in from a generically-typed tool input at this layer;
 * anything that isn't a real boolean is treated as absent.
 */
function flag(value: unknown): "1" | "0" | undefined {
  if (typeof value !== "boolean") return undefined;
  return value ? "1" : "0";
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

defineTool({
  name: "domains_list",
  domain: "domains",
  tier: "read",
  whmcsAction: "GetClientsDomains",
  description:
    "Lists domains under management in WHMCS, optionally filtered by client, domain id, or domain name.",
  inputSchema: domainsListSchema,
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const raw = (await ctx.whmcs.call("GetClientsDomains", {
      clientid: input.clientid,
      domainid: input.domainid,
      domain: input.domain,
      limitstart: input.limitstart,
      limitnum: input.limitnum,
    })) as unknown as WhmcsGetClientsDomainsRaw;
    const domains = unwrapCollection<DomainRaw>(raw, "domain");
    return { data: { totalresults: raw.totalresults, domains } };
  },
});

defineTool({
  name: "domains_whois_availability",
  domain: "domains",
  tier: "read",
  whmcsAction: "DomainWhois",
  description:
    "Runs a live WHOIS availability/status lookup for a domain name via the connected WHMCS instance's registrar configuration.",
  inputSchema: domainsWhoisAvailabilitySchema,
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("DomainWhois", { domain: input.domain });
    return { data: res };
  },
});

defineTool({
  name: "domains_get_nameservers",
  domain: "domains",
  tier: "read",
  whmcsAction: "DomainGetNameservers",
  description: "Returns the current nameservers (ns1-ns5) configured for a domain.",
  inputSchema: domainsGetNameserversSchema,
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("DomainGetNameservers", { domainid: input.domainid });
    return { data: res };
  },
});

defineTool({
  name: "domains_get_locking_status",
  domain: "domains",
  tier: "read",
  whmcsAction: "DomainGetLockingStatus",
  description: "Returns whether a domain currently has the registrar transfer lock enabled.",
  inputSchema: domainsGetLockingStatusSchema,
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("DomainGetLockingStatus", { domainid: input.domainid });
    return { data: res };
  },
});

defineTool({
  name: "domains_get_whois_info",
  domain: "domains",
  tier: "read",
  whmcsAction: "DomainGetWhoisInfo",
  description:
    "Returns the Registrant/Admin/Technical/Billing WHOIS contact records on file for a domain. " +
    "Contact PII (email, phone, fax, address) is masked unless WHMCS_MCP_REDACT_PII=false.",
  inputSchema: domainsGetWhoisInfoSchema,
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const raw = (await ctx.whmcs.call("DomainGetWhoisInfo", {
      domainid: input.domainid,
    })) as unknown as WhmcsDomainWhoisInfoResult;
    return { data: redactWhoisContacts(raw, ctx.config.redactPii) };
  },
});

defineTool({
  name: "domains_get_tld_pricing",
  domain: "domains",
  tier: "read",
  whmcsAction: "GetTLDPricing",
  description:
    "Returns register/transfer/renew pricing per TLD, optionally for a specific currency or client's pricing group.",
  inputSchema: domainsGetTldPricingSchema,
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = (await ctx.whmcs.call("GetTLDPricing", {
      currencyid: input.currencyid,
      clientid: input.clientid,
    })) as unknown as WhmcsGetTLDPricingRaw;
    return { data: res };
  },
});

// ---------------------------------------------------------------------------
// Writes (tier: write) — confirm-gated
// ---------------------------------------------------------------------------

defineTool({
  name: "domains_update_nameservers",
  domain: "domains",
  tier: "write",
  whmcsAction: "DomainUpdateNameservers",
  description:
    "Updates a domain's nameservers at the registrar. Requires domainid or domain, plus ns1/ns2 " +
    "(ns3-ns5 optional). Two-step confirm: call once to preview, then again with the returned " +
    "confirmToken to apply. Pass dryRun:true to only validate and preview.",
  inputSchema: domainsUpdateNameserversSchema,
  annotations: { readOnlyHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("DomainUpdateNameservers", {
      domainid: input.domainid,
      domain: input.domain,
      ns1: input.ns1,
      ns2: input.ns2,
      ns3: input.ns3,
      ns4: input.ns4,
      ns5: input.ns5,
    });
    return { data: res, summary: `Nameservers updated for domain ${String(input.domainid ?? input.domain)}.` };
  },
});

defineTool({
  name: "domains_update_locking_status",
  domain: "domains",
  tier: "write",
  whmcsAction: "DomainUpdateLockingStatus",
  description:
    "Enables or disables the registrar transfer lock on a domain. Two-step confirm: call once to " +
    "preview, then again with the returned confirmToken to apply. Pass dryRun:true to only preview.",
  inputSchema: domainsUpdateLockingStatusSchema,
  annotations: { readOnlyHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("DomainUpdateLockingStatus", {
      domainid: input.domainid,
      lockstatus: flag(input.lockstatus),
    });
    return {
      data: res,
      summary: `Registrar lock ${input.lockstatus ? "enabled" : "disabled"} for domain ${String(input.domainid)}.`,
    };
  },
});

defineTool({
  name: "domains_update",
  domain: "domains",
  tier: "write",
  whmcsAction: "UpdateClientDomain",
  description:
    "Updates a domain's WHMCS record: status, renewal date/amount, renewal period, autorecalc, DNS " +
    "management/email forwarding/ID protection add-on flags, do-not-renew, and notes. Pass dryRun:true " +
    "to validate and preview without calling WHMCS.",
  inputSchema: domainsUpdateSchema,
  annotations: { readOnlyHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("UpdateClientDomain", {
      domainid: input.domainid,
      status: input.status,
      nextduedate: input.nextduedate,
      expirydate: input.expirydate,
      regperiod: input.regperiod,
      recurringamount: input.recurringamount,
      autorecalc: flag(input.autorecalc),
      dnsmanagement: flag(input.dnsmanagement),
      emailforwarding: flag(input.emailforwarding),
      idprotection: flag(input.idprotection),
      donotrenew: flag(input.donotrenew),
      notes: input.notes,
    });
    return { data: res, summary: `Domain ${String(input.domainid)} record updated.` };
  },
});

// ---------------------------------------------------------------------------
// Billing (tier: billing) — only advertised when WHMCS_MCP_MODE=full, per
// the operator's "invoices are operator-manual" policy: these tools create
// or affect registrar billing, so they stay off by default.
// ---------------------------------------------------------------------------

defineTool({
  name: "domains_renew",
  domain: "domains",
  tier: "billing",
  whmcsAction: "DomainRenew",
  description:
    "Renews a domain at the registrar for the given period, generating a renewal invoice. " +
    "Billing-tier: only available when WHMCS_MCP_MODE=full. Two-step confirm required; pass " +
    "dryRun:true to only preview.",
  inputSchema: domainsRenewSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("DomainRenew", {
      domainid: input.domainid,
      domain: input.domain,
      regperiod: input.regperiod,
    });
    return { data: res, summary: `Domain ${String(input.domainid ?? input.domain)} renewal submitted.` };
  },
  buildConfirmationPreview: (input) =>
    `This will renew domain ${String(input.domainid ?? input.domain)} for ${String(input.regperiod ?? "the default")} period(s) and generate a renewal invoice.`,
});

defineTool({
  name: "domains_register",
  domain: "domains",
  tier: "billing",
  whmcsAction: "DomainRegister",
  description:
    "Registers a pending domain order at the registrar. Billing-tier: only available when " +
    "WHMCS_MCP_MODE=full. Two-step confirm required; pass dryRun:true to only preview.",
  inputSchema: domainsRegisterSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("DomainRegister", {
      domainid: input.domainid,
      domain: input.domain,
      idnlanguage: input.idnlanguage,
    });
    return { data: res, summary: `Domain ${String(input.domainid ?? input.domain)} registration submitted.` };
  },
  buildConfirmationPreview: (input) =>
    `This will register domain ${String(input.domainid ?? input.domain)} at the registrar.`,
});

defineTool({
  name: "domains_transfer",
  domain: "domains",
  tier: "billing",
  whmcsAction: "DomainTransfer",
  description:
    "Initiates an inbound domain transfer at the registrar using the supplied EPP/auth code. " +
    "Billing-tier: only available when WHMCS_MCP_MODE=full. eppcode is never logged. Two-step confirm " +
    "required; pass dryRun:true to only preview (the eppcode is still included in the preview payload " +
    "returned to the caller, since it is required input — it is not logged server-side).",
  inputSchema: domainsTransferSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    // eppcode is a one-time transfer secret: it is sent to WHMCS in the
    // request body only (never logged — see whmcs-client.ts's call() doc).
    // WHMCS's own response for this action does not echo the code back.
    const res = await ctx.whmcs.call("DomainTransfer", {
      domainid: input.domainid,
      domain: input.domain,
      eppcode: input.eppcode,
    });
    return { data: res, summary: `Domain ${String(input.domainid ?? input.domain)} transfer initiated.` };
  },
  buildConfirmationPreview: (input) =>
    `This will initiate an inbound transfer for domain ${String(input.domainid ?? input.domain)} using the supplied EPP/auth code.`,
});
