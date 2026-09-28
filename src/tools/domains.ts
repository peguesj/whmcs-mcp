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
 * Safety posture (see docs/configuration.md + SECURITY.md once written):
 *  - Every tool is skipped at registration time unless BOTH
 *    `ctx.isDomainEnabled("domains")` and `ctx.isTierAllowed(tier)` are true,
 *    so an unauthorized tool never even appears in the client's tool list.
 *  - `write`- and `billing`-tier tools implement a two-step confirm flow:
 *    the first call (no `confirmToken`) validates input, serializes the
 *    WHMCS params it *would* send, and returns that preview plus a
 *    short-lived (5 min), single-use `confirmToken`; the second call must
 *    echo that token to actually reach the network. `dryRun: true` always
 *    short-circuits to a preview with no token issued and no network call,
 *    regardless of tier.
 *  - `domains_transfer`'s `eppcode` and `domains_get_whois_info`'s
 *    registrant contact fields are the two PII/secret-adjacent surfaces in
 *    this domain; both are covered by the local `redactForOutput()` /
 *    `redactWhoisContacts()` helpers below.
 *
 * NOTE ON CONFIRM-TOKEN STORAGE: `src/safety/confirm.ts` (see the
 * architecture plan's fileLayout) is the intended shared implementation of
 * this two-step flow, so every tool module signs/verifies confirm tokens
 * the same way. That file does not exist in the tree yet at the time this
 * module was written, so the confirm-token store below is a self-contained,
 * same-process, in-memory stand-in scoped to this file. It follows the same
 * contract the shared module is specified to have (HMAC-bound to tool name
 * + a stable hash of the args, 5 minute TTL, single use) so swapping the
 * `issueConfirmToken` / `redeemConfirmToken` calls below for imports from
 * `../safety/confirm.js` later is a pure substitution with no behavior
 * change. Do not duplicate this store elsewhere; once `safety/confirm.ts`
 * lands, migrate this file to it.
 *
 * NOTE ON REDACTION: for the same reason, a minimal local redaction helper
 * is defined here rather than imported from the not-yet-existing
 * `src/safety/redact.ts`. It only covers this domain's two PII/secret
 * surfaces; it is not a substitute for the shared redaction layer the plan
 * specifies, which should also cover this module's output once it exists.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";

import type { ToolRegistrationContext } from "../index.js";
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
import {
  WhmcsApiError,
  WhmcsTimeoutError,
  unwrapCollection,
  type WhmcsCallParams,
} from "../whmcs-client.js";
import type {
  DomainRaw,
  WhmcsGetClientsDomainsRaw,
  WhmcsDomainWhoisResult,
  WhmcsDomainGetNameserversResult,
  WhmcsDomainUpdateNameserversResult,
  WhmcsDomainGetLockingStatusResult,
  WhmcsDomainUpdateLockingStatusResult,
  WhmcsDomainWhoisInfoResult,
  WhmcsUpdateClientDomainResult,
  WhmcsDomainRenewResult,
  WhmcsDomainRegisterResult,
  WhmcsDomainTransferResult,
  WhmcsGetTLDPricingRaw,
} from "../types/whmcs.js";

const DOMAIN_TOOL = "domains" as const;

// ---------------------------------------------------------------------------
// Confirm-token stand-in (see file header NOTE ON CONFIRM-TOKEN STORAGE)
// ---------------------------------------------------------------------------

interface PendingConfirmation {
  toolName: string;
  argsHash: string;
  expiresAt: number;
}

const CONFIRM_TTL_MS = 5 * 60 * 1000;
const pendingConfirmations = new Map<string, PendingConfirmation>();

/** Stable hash of a tool's input, used to bind a confirm token to the exact args it previewed. */
function hashArgs(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(args)).digest("hex");
}

/**
 * Issues a single-use confirm token bound to `toolName` + a hash of `args`,
 * valid for `CONFIRM_TTL_MS`. The HMAC key is process-local and regenerated
 * per server start, so tokens never survive a restart — acceptable for a
 * 5-minute confirm window.
 */
const processConfirmKey = randomBytes(32);

function issueConfirmToken(toolName: string, args: unknown): string {
  const id = randomBytes(16).toString("base64url");
  const argsHash = hashArgs(args);
  pendingConfirmations.set(id, {
    toolName,
    argsHash,
    expiresAt: Date.now() + CONFIRM_TTL_MS,
  });
  const mac = createHmac("sha256", processConfirmKey)
    .update(`${id}:${toolName}:${argsHash}`)
    .digest("base64url");
  return `${id}.${mac}`;
}

type ConfirmCheck =
  | { ok: true }
  | { ok: false; reason: "invalid" | "expired" | "args-mismatch" };

/** Verifies and (on success) consumes a confirm token — single use, per the plan's confirm.ts spec. */
function redeemConfirmToken(
  token: string,
  toolName: string,
  args: unknown,
): ConfirmCheck {
  const [id, mac] = token.split(".");
  if (!id || !mac) return { ok: false, reason: "invalid" };
  const pending = pendingConfirmations.get(id);
  if (!pending) return { ok: false, reason: "invalid" };

  const argsHash = hashArgs(args);
  const expectedMac = createHmac("sha256", processConfirmKey)
    .update(`${id}:${toolName}:${pending.argsHash}`)
    .digest("base64url");
  if (mac !== expectedMac || pending.toolName !== toolName) {
    return { ok: false, reason: "invalid" };
  }
  if (Date.now() > pending.expiresAt) {
    pendingConfirmations.delete(id);
    return { ok: false, reason: "expired" };
  }
  if (argsHash !== pending.argsHash) {
    // Same token, different args on the second call — refuse rather than
    // silently applying a mutation the operator never actually previewed.
    return { ok: false, reason: "args-mismatch" };
  }
  pendingConfirmations.delete(id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Minimal local redaction (see file header NOTE ON REDACTION)
// ---------------------------------------------------------------------------

const EPPCODE_PATTERN = /eppcode\W{0,3}\S+/gi;

/** Defense-in-depth scrub of an error message in case WHMCS ever echoes a submitted eppcode back. */
function scrubEppcodeFromMessage(message: string): string {
  return message.replace(EPPCODE_PATTERN, "eppcode [REDACTED]");
}

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
      maskedContact[key] = WHOIS_PII_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : value;
    }
    redacted[block] = maskedContact;
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// WHMCS param serialization helpers
// ---------------------------------------------------------------------------

/** WHMCS boolean-ish fields (lockstatus, autorecalc, dnsmanagement, ...) are sent as "1"/"0", never true/false. */
function flag(value: boolean | undefined): "1" | "0" | undefined {
  if (value === undefined) return undefined;
  return value ? "1" : "0";
}

function normalizeDomain(result: DomainRaw): DomainRaw {
  return result;
}

// ---------------------------------------------------------------------------
// Shared registration plumbing
// ---------------------------------------------------------------------------

type Tier = "read" | "write" | "billing" | "destructive";

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function textResult(
  data: unknown,
  extra?: Partial<McpToolResult>,
): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    ...(data && typeof data === "object"
      ? { structuredContent: data as Record<string, unknown> }
      : {}),
    ...extra,
  };
}

function errorResult(message: string): McpToolResult {
  return {
    content: [{ type: "text", text: scrubEppcodeFromMessage(message) }],
    isError: true,
  };
}

/**
 * Wraps a tool handler with the shared safety envelope: tier/domain gating
 * at registration time (the caller checks this before invoking
 * `register()`), plus at call time: input validation via the full zod
 * schema (including any `.refine()` cross-field rules), the dryRun
 * short-circuit, and — for `requiresConfirm` tools — the two-step
 * confirm-token flow. `buildPreview` turns validated input into the exact
 * WHMCS params the tool would send, which doubles as the dryRun/preview
 * payload and the args passed to the live `execute` call.
 */
function register<TSchema extends z.ZodTypeAny>(
  ctx: ToolRegistrationContext,
  opts: {
    name: string;
    title: string;
    description: string;
    tier: Tier;
    schema: TSchema;
    inputShape: z.ZodRawShape;
    annotations?: ToolAnnotations;
    requiresConfirm?: boolean;
    buildParams: (input: z.infer<TSchema>) => WhmcsCallParams;
    action: string;
    execute: (raw: unknown, input: z.infer<TSchema>) => unknown;
  },
): void {
  if (!ctx.isDomainEnabled(DOMAIN_TOOL) || !ctx.isTierAllowed(opts.tier)) {
    return;
  }

  ctx.server.registerTool(
    opts.name,
    {
      title: opts.title,
      description: opts.description,
      inputSchema: opts.inputShape,
      annotations: {
        title: opts.title,
        readOnlyHint: opts.tier === "read",
        openWorldHint: true,
        ...opts.annotations,
      },
    },
    async (rawInput: unknown): Promise<McpToolResult> => {
      let input: z.infer<TSchema>;
      try {
        input = opts.schema.parse(rawInput);
      } catch (err) {
        return errorResult(
          `Invalid input for ${opts.name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const params = opts.buildParams(input);
      const dryRun = Boolean((input as { dryRun?: boolean }).dryRun);
      const confirmToken = (input as { confirmToken?: string }).confirmToken;

      const preview = {
        tool: opts.name,
        whmcsAction: opts.action,
        params,
      };

      if (dryRun) {
        return textResult({ dryRun: true, ...preview });
      }

      if (opts.requiresConfirm) {
        if (!confirmToken) {
          const token = issueConfirmToken(opts.name, params);
          return textResult({
            confirmationRequired: true,
            confirmToken: token,
            expiresInSeconds: CONFIRM_TTL_MS / 1000,
            ...preview,
          });
        }
        const check = redeemConfirmToken(confirmToken, opts.name, params);
        if (!check.ok) {
          return errorResult(
            `confirmToken ${check.reason} for ${opts.name}. Call again without confirmToken to get a fresh preview.`,
          );
        }
      }

      try {
        const raw = await ctx.client.call(opts.action, params);
        const result = opts.execute(raw, input);
        return textResult(result);
      } catch (err) {
        if (err instanceof WhmcsApiError) {
          return errorResult(
            `WHMCS ${opts.action} failed: ${err.whmcsMessage ?? err.message}`,
          );
        }
        if (err instanceof WhmcsTimeoutError) {
          return errorResult(err.message);
        }
        return errorResult(
          `Unexpected error calling ${opts.action}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Public entry point, called from src/index.ts's buildServer()
// ---------------------------------------------------------------------------

export function registerDomainTools(ctx: ToolRegistrationContext): void {
  // -- domains_list -> GetClientsDomains [read] ----------------------------
  register(ctx, {
    name: "domains_list",
    title: "List domains",
    description:
      "Lists domains under management in WHMCS, optionally filtered by client, domain id, or domain name (WHMCS action: GetClientsDomains).",
    tier: "read",
    schema: domainsListSchema,
    inputShape: domainsListSchema.shape,
    annotations: { idempotentHint: true },
    action: "GetClientsDomains",
    buildParams: (input) => ({
      clientid: input.clientid,
      domainid: input.domainid,
      domain: input.domain,
      limitstart: input.limitstart,
      limitnum: input.limitnum,
    }),
    execute: (raw) => {
      const parsed = raw as WhmcsGetClientsDomainsRaw;
      const domains = unwrapCollection<DomainRaw>(
        parsed as unknown as Record<string, unknown>,
        "domain",
      ).map(normalizeDomain);
      return {
        totalresults: parsed.totalresults,
        domains,
      };
    },
  });

  // -- domains_whois_availability -> DomainWhois [read] --------------------
  register(ctx, {
    name: "domains_whois_availability",
    title: "Check domain WHOIS availability",
    description:
      "Runs a live WHOIS availability/status lookup for a domain name via the connected WHMCS instance's registrar configuration (WHMCS action: DomainWhois).",
    tier: "read",
    schema: domainsWhoisAvailabilitySchema,
    inputShape: domainsWhoisAvailabilitySchema.shape,
    annotations: { idempotentHint: true },
    action: "DomainWhois",
    buildParams: (input) => ({ domain: input.domain }),
    execute: (raw) => raw as WhmcsDomainWhoisResult,
  });

  // -- domains_get_nameservers -> DomainGetNameservers [read] --------------
  register(ctx, {
    name: "domains_get_nameservers",
    title: "Get domain nameservers",
    description:
      "Returns the current nameservers (ns1-ns5) configured for a domain (WHMCS action: DomainGetNameservers).",
    tier: "read",
    schema: domainsGetNameserversSchema,
    inputShape: domainsGetNameserversSchema.shape,
    annotations: { idempotentHint: true },
    action: "DomainGetNameservers",
    buildParams: (input) => ({ domainid: input.domainid }),
    execute: (raw) => raw as WhmcsDomainGetNameserversResult,
  });

  // -- domains_update_nameservers -> DomainUpdateNameservers [write, confirm]
  register(ctx, {
    name: "domains_update_nameservers",
    title: "Update domain nameservers",
    description:
      "Updates a domain's nameservers at the registrar (WHMCS action: DomainUpdateNameservers). Requires domainid or domain, plus ns1/ns2 (ns3-ns5 optional). Two-step confirm: call once to preview, then again with the returned confirmToken to apply. Pass dryRun:true to only validate and preview.",
    tier: "write",
    requiresConfirm: true,
    schema: domainsUpdateNameserversSchema,
    inputShape: domainsUpdateNameserversSchema.shape,
    annotations: { idempotentHint: true },
    action: "DomainUpdateNameservers",
    buildParams: (input) => ({
      domainid: input.domainid,
      domain: input.domain,
      ns1: input.ns1,
      ns2: input.ns2,
      ns3: input.ns3,
      ns4: input.ns4,
      ns5: input.ns5,
    }),
    execute: (raw) => raw as WhmcsDomainUpdateNameserversResult,
  });

  // -- domains_get_locking_status -> DomainGetLockingStatus [read] ---------
  register(ctx, {
    name: "domains_get_locking_status",
    title: "Get domain registrar-lock status",
    description:
      "Returns whether a domain currently has the registrar transfer lock enabled (WHMCS action: DomainGetLockingStatus).",
    tier: "read",
    schema: domainsGetLockingStatusSchema,
    inputShape: domainsGetLockingStatusSchema.shape,
    annotations: { idempotentHint: true },
    action: "DomainGetLockingStatus",
    buildParams: (input) => ({ domainid: input.domainid }),
    execute: (raw) => raw as WhmcsDomainGetLockingStatusResult,
  });

  // -- domains_update_locking_status -> DomainUpdateLockingStatus [write, confirm]
  register(ctx, {
    name: "domains_update_locking_status",
    title: "Set domain registrar-lock status",
    description:
      "Enables or disables the registrar transfer lock on a domain (WHMCS action: DomainUpdateLockingStatus). Two-step confirm: call once to preview, then again with the returned confirmToken to apply. Pass dryRun:true to only validate and preview.",
    tier: "write",
    requiresConfirm: true,
    schema: domainsUpdateLockingStatusSchema,
    inputShape: domainsUpdateLockingStatusSchema.shape,
    annotations: { idempotentHint: true },
    action: "DomainUpdateLockingStatus",
    buildParams: (input) => ({
      domainid: input.domainid,
      lockstatus: flag(input.lockstatus),
    }),
    execute: (raw) => raw as WhmcsDomainUpdateLockingStatusResult,
  });

  // -- domains_get_whois_info -> DomainGetWhoisInfo [read, PII] ------------
  register(ctx, {
    name: "domains_get_whois_info",
    title: "Get domain WHOIS contact info",
    description:
      "Returns the Registrant/Admin/Technical/Billing WHOIS contact records on file for a domain (WHMCS action: DomainGetWhoisInfo). Contact PII (email, phone, fax, address) is masked unless WHMCS_MCP_REDACT_PII=false.",
    tier: "read",
    schema: domainsGetWhoisInfoSchema,
    inputShape: domainsGetWhoisInfoSchema.shape,
    annotations: { idempotentHint: true },
    action: "DomainGetWhoisInfo",
    buildParams: (input) => ({ domainid: input.domainid }),
    execute: (raw) =>
      redactWhoisContacts(
        raw as WhmcsDomainWhoisInfoResult,
        ctx.config.redactPii,
      ),
  });

  // -- domains_update -> UpdateClientDomain [write] ------------------------
  register(ctx, {
    name: "domains_update",
    title: "Update domain record",
    description:
      "Updates a domain's WHMCS record: status, renewal date/amount, renewal period, autorecalc, DNS management/email forwarding/ID protection add-on flags, do-not-renew, and notes (WHMCS action: UpdateClientDomain). Pass dryRun:true to validate and preview without calling WHMCS.",
    tier: "write",
    schema: domainsUpdateSchema,
    inputShape: domainsUpdateSchema.shape,
    annotations: { idempotentHint: true },
    action: "UpdateClientDomain",
    buildParams: (input) => ({
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
    }),
    execute: (raw) => raw as WhmcsUpdateClientDomainResult,
  });

  // -- domains_renew -> DomainRenew [billing, confirm] ---------------------
  // Billing-tier: only advertised when WHMCS_MCP_MODE=full, per the
  // operator's "invoices are operator-manual" policy from the plan — this
  // tool creates/affects a renewal invoice, so it stays off by default and
  // must never be enabled in a 3VS production deployment config.
  register(ctx, {
    name: "domains_renew",
    title: "Renew domain",
    description:
      "Renews a domain at the registrar for the given period, generating a renewal invoice (WHMCS action: DomainRenew). Billing-tier: only available when WHMCS_MCP_MODE=full. Two-step confirm required; pass dryRun:true to only preview.",
    tier: "billing",
    requiresConfirm: true,
    schema: domainsRenewSchema,
    inputShape: domainsRenewSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
    action: "DomainRenew",
    buildParams: (input) => ({
      domainid: input.domainid,
      domain: input.domain,
      regperiod: input.regperiod,
    }),
    execute: (raw) => raw as WhmcsDomainRenewResult,
  });

  // -- domains_register -> DomainRegister [billing, confirm] ---------------
  register(ctx, {
    name: "domains_register",
    title: "Register domain",
    description:
      "Registers a pending domain order at the registrar (WHMCS action: DomainRegister). Billing-tier: only available when WHMCS_MCP_MODE=full. Two-step confirm required; pass dryRun:true to only preview.",
    tier: "billing",
    requiresConfirm: true,
    schema: domainsRegisterSchema,
    inputShape: domainsRegisterSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
    action: "DomainRegister",
    buildParams: (input) => ({
      domainid: input.domainid,
      domain: input.domain,
      idnlanguage: input.idnlanguage,
    }),
    execute: (raw) => raw as WhmcsDomainRegisterResult,
  });

  // -- domains_transfer -> DomainTransfer [billing, confirm] ---------------
  // eppcode is a one-time transfer secret: it is sent to WHMCS in the
  // request body only (never logged — see whmcs-client.ts's call() doc) and
  // is scrubbed from any error message this tool returns via
  // scrubEppcodeFromMessage(). WHMCS's own response for this action does
  // not echo the code back.
  register(ctx, {
    name: "domains_transfer",
    title: "Transfer domain in",
    description:
      "Initiates an inbound domain transfer at the registrar using the supplied EPP/auth code (WHMCS action: DomainTransfer). Billing-tier: only available when WHMCS_MCP_MODE=full. eppcode is never logged. Two-step confirm required; pass dryRun:true to only preview (the eppcode is still included in the preview payload returned to the caller, since it is required input — it is not logged server-side).",
    tier: "billing",
    requiresConfirm: true,
    schema: domainsTransferSchema,
    inputShape: domainsTransferSchema.shape,
    annotations: { destructiveHint: true, idempotentHint: false },
    action: "DomainTransfer",
    buildParams: (input) => ({
      domainid: input.domainid,
      domain: input.domain,
      eppcode: input.eppcode,
    }),
    execute: (raw) => raw as WhmcsDomainTransferResult,
  });

  // -- domains_get_tld_pricing -> GetTLDPricing [read] ---------------------
  register(ctx, {
    name: "domains_get_tld_pricing",
    title: "Get TLD pricing",
    description:
      "Returns register/transfer/renew pricing per TLD, optionally for a specific currency or client's pricing group (WHMCS action: GetTLDPricing).",
    tier: "read",
    schema: domainsGetTldPricingSchema,
    inputShape: domainsGetTldPricingSchema.shape,
    annotations: { idempotentHint: true },
    action: "GetTLDPricing",
    buildParams: (input) => ({
      currencyid: input.currencyid,
      clientid: input.clientid,
    }),
    execute: (raw) => raw as WhmcsGetTLDPricingRaw,
  });
}
