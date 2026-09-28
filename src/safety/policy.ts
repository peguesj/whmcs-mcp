/**
 * src/safety/policy.ts
 *
 * Tier model + mode matrix for the WHMCS MCP server.
 *
 * Every registered tool declares a `Tier`. The active `WHMCS_MCP_MODE`
 * (readonly | write | full) determines which tiers are advertised to the
 * MCP client at all -- a tool whose tier is not enabled for the current
 * mode is not registered on the McpServer, so the model never even sees
 * it in the tool list. This is a stricter guarantee than "the handler
 * refuses": an unavailable tool cannot be called, confirmed, or dry-run.
 *
 * Tiers (least to most dangerous):
 *   - "read"        Read-only WHMCS External API calls. No side effects.
 *   - "write"       Non-financial mutations (tickets, client records,
 *                    domain nameservers, service metadata, etc).
 *   - "billing"     Invoice, payment, credit, quote and order mutations
 *                    that touch money. Operator policy ("invoices are
 *                    operator-manual") means this tier ships disabled
 *                    unless the deployment explicitly opts in via
 *                    WHMCS_MCP_MODE=full. Never enable this tier in a
 *                    3VS/production deployment config.
 *   - "destructive" Irreversible or hard-to-reverse actions (delete,
 *                    merge, terminate, cancel/fraud-mark). Always
 *                    confirmation-gated regardless of mode.
 *
 * Mode matrix:
 *   - "readonly" (default): only "read" tools are advertised.
 *   - "write":    "read" + "write" tools are advertised. "billing" and
 *                 "destructive" remain hidden.
 *   - "full":     every tier is advertised, including "billing" and
 *                 "destructive". This is the only mode in which invoice-
 *                 mutating tools (billing_create_invoice, billing_update_invoice,
 *                 billing_add_payment, billing_apply_credit,
 *                 billing_capture_payment) can ever be registered.
 *
 * WHMCS_MCP_ENABLE_DOMAINS further narrows the surface by tool domain
 * (tickets, clients, products, invoices, domains, orders, system) on top
 * of whatever the mode allows -- both gates must pass for a tool to be
 * advertised.
 */

/** Tool danger tier. Every tool registration must declare exactly one. */
export type Tier = "read" | "write" | "billing" | "destructive";

/** Server operating mode, from WHMCS_MCP_MODE (default "readonly"). */
export type Mode = "readonly" | "write" | "full";

/** WHMCS tool domains, matching the src/tools/<domain>.ts file layout. */
export type ToolDomain =
  | "system"
  | "tickets"
  | "clients"
  | "products"
  | "invoices"
  | "domains"
  | "orders"
  | "custom";

export const ALL_TIERS: readonly Tier[] = [
  "read",
  "write",
  "billing",
  "destructive",
] as const;

export const ALL_MODES: readonly Mode[] = ["readonly", "write", "full"] as const;

export const ALL_DOMAINS: readonly ToolDomain[] = [
  "system",
  "tickets",
  "clients",
  "products",
  "invoices",
  "domains",
  "orders",
  "custom",
] as const;

/**
 * The mode -> tier matrix. Order matters for readability only; lookups use
 * the Set for O(1) membership checks. This is the single source of truth
 * for "which tiers does this mode advertise" -- do not duplicate this
 * logic elsewhere (e.g. by comparing mode strings ad hoc in tools/*.ts).
 */
const MODE_TIER_MATRIX: Readonly<Record<Mode, ReadonlySet<Tier>>> = {
  readonly: new Set<Tier>(["read"]),
  write: new Set<Tier>(["read", "write"]),
  // "full" is the only mode that ever exposes billing/destructive tools.
  // Operator policy: invoice-mutating tools must stay off in any 3VS
  // production deployment config regardless of this matrix -- gate at the
  // deployment's env file, not just here.
  full: new Set<Tier>(["read", "write", "billing", "destructive"]),
};

/**
 * Tools whose actions are always confirmation-gated (two-step confirm
 * token flow via src/safety/confirm.ts) irrespective of tier, because a
 * single call would be destructive or irreversible even though the tier
 * itself might otherwise be "write". Kept here (not just tagged per tool)
 * so the policy is auditable in one place; individual tool registrations
 * also set their own tier + confirm requirement, and both must agree.
 */
const ALWAYS_CONFIRM_TIERS: ReadonlySet<Tier> = new Set<Tier>([
  "billing",
  "destructive",
]);

/**
 * True when `tier` is always confirmation-gated regardless of a tool's own
 * `requiresConfirm` registration flag. Exposed so src/tools/registry.ts can
 * decide, per call, whether to run the two-step confirm-token flow without
 * duplicating the tier policy locally.
 */
export function requiresConfirmation(tier: Tier): boolean {
  return ALWAYS_CONFIRM_TIERS.has(tier);
}

/** Describes the safety-relevant metadata a tool registration must supply. */
export interface ToolPolicyInput {
  /** Tool name as advertised over MCP, e.g. "tickets_delete". */
  name: string;
  /** Domain used for WHMCS_MCP_ENABLE_DOMAINS filtering. */
  domain: ToolDomain;
  /** Danger tier. Determines mode-gating and default confirm requirement. */
  tier: Tier;
  /**
   * Explicit confirm override. Omit to use the tier default
   * (true for billing/destructive, false otherwise). A tool may force
   * `true` even on a lower tier (e.g. a bulk write) but may never force
   * `false` on billing/destructive -- see assertToolPolicy.
   */
  requiresConfirm?: boolean;
}

/** Resolved policy for a tool, after applying tier defaults. */
export interface ResolvedToolPolicy extends Required<ToolPolicyInput> {
  /** MCP annotation hints derived from tier, per the MCP spec. */
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
}

/**
 * Config shape consumed from src/config.ts. Duplicated narrowly here
 * (rather than importing config.ts) to keep this module dependency-free
 * and easy to unit test in isolation; src/config.ts is the source of
 * truth for parsing/validating the underlying env vars.
 */
export interface SafetyModeConfig {
  mode: Mode;
  /** Lowercase domain names enabled via WHMCS_MCP_ENABLE_DOMAINS, or
   * undefined/empty to mean "all domains enabled" (the default). */
  enabledDomains?: ReadonlySet<ToolDomain>;
}

/** True if `tier` is advertised under the given server `mode`. */
export function isTierEnabledForMode(tier: Tier, mode: Mode): boolean {
  return MODE_TIER_MATRIX[mode].has(tier);
}

/** True if `domain` is enabled under the given domain allowlist (undefined = all). */
export function isDomainEnabled(
  domain: ToolDomain,
  enabledDomains: ReadonlySet<ToolDomain> | undefined,
): boolean {
  if (!enabledDomains || enabledDomains.size === 0) return true;
  return enabledDomains.has(domain);
}

/**
 * Whether a tool with the given tier+domain should be registered on the
 * McpServer at all, under the current safety config. Both the mode gate
 * and the domain gate must pass. Call this before `server.registerTool(...)`
 * for every tool; never register a tool unconditionally and rely on the
 * handler to refuse, since that would still leak the tool's existence and
 * schema to the client's tool list.
 */
export function isToolAdvertised(
  input: Pick<ToolPolicyInput, "tier" | "domain">,
  config: SafetyModeConfig,
): boolean {
  return (
    isTierEnabledForMode(input.tier, config.mode) &&
    isDomainEnabled(input.domain, config.enabledDomains)
  );
}

/**
 * Resolves the full policy for a tool, applying the tier's default confirm
 * requirement when the registration does not set one explicitly, and
 * refusing to let a billing/destructive tool opt out of confirmation.
 *
 * Throws at registration time (fail fast, not at call time) if a tool
 * definition tries to weaken the confirm guarantee for a dangerous tier --
 * this is a programming-error guard, not a runtime/user-input check.
 */
export function resolveToolPolicy(input: ToolPolicyInput): ResolvedToolPolicy {
  const tierDefaultConfirm = ALWAYS_CONFIRM_TIERS.has(input.tier);
  const requiresConfirm = input.requiresConfirm ?? tierDefaultConfirm;

  if (tierDefaultConfirm && !requiresConfirm) {
    throw new Error(
      `Safety policy violation: tool "${input.name}" has tier "${input.tier}" ` +
        `which always requires confirmation, but its registration set ` +
        `requiresConfirm=false. Fix the tool definition; this is not overridable.`,
    );
  }

  return {
    name: input.name,
    domain: input.domain,
    tier: input.tier,
    requiresConfirm,
    annotations: {
      readOnlyHint: input.tier === "read",
      destructiveHint:
        input.tier === "destructive" || input.tier === "billing",
      // Reads and most writes are idempotent from the caller's point of
      // view (re-issuing them is safe); destructive/billing actions
      // generally are not (e.g. AddInvoicePayment, MergeTicket).
      idempotentHint: input.tier === "read" || input.tier === "write",
    },
  };
}

/**
 * Convenience guard for use inside a tool handler as defense in depth:
 * even though `isToolAdvertised` should have kept a disabled tool out of
 * the tool list entirely, a client that already cached an old tool list
 * (or a raw JSON-RPC call bypassing discovery) could still attempt to
 * invoke it. Handlers built via src/tools/registry.ts call this before
 * doing any network I/O and throw a typed, redaction-safe error if it
 * fails, rather than silently no-op'ing.
 */
export function assertToolAllowed(
  input: Pick<ToolPolicyInput, "name" | "tier" | "domain">,
  config: SafetyModeConfig,
): void {
  if (!isToolAdvertised(input, config)) {
    throw new Error(
      `Tool "${input.name}" (tier "${input.tier}", domain "${input.domain}") ` +
        `is not enabled under WHMCS_MCP_MODE="${config.mode}"` +
        (config.enabledDomains
          ? ` with WHMCS_MCP_ENABLE_DOMAINS restricted to [${[...config.enabledDomains].join(", ")}]`
          : "") +
        `. This should be unreachable via normal MCP tool discovery.`,
    );
  }
}

/**
 * Parses a WHMCS_MCP_ENABLE_DOMAINS-style comma-separated string (e.g.
 * "tickets,clients,invoices") into a validated domain set. Unknown domain
 * names are rejected loudly rather than silently ignored, since a typo'd
 * domain name silently disabling a whole tool category is exactly the
 * kind of failure this policy module exists to prevent.
 */
export function parseEnabledDomains(
  raw: string | undefined,
): ReadonlySet<ToolDomain> | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  const domainSet = new Set<ToolDomain>();
  for (const part of trimmed.split(",")) {
    const name = part.trim().toLowerCase();
    if (name.length === 0) continue;
    if (!(ALL_DOMAINS as readonly string[]).includes(name)) {
      throw new Error(
        `Invalid WHMCS_MCP_ENABLE_DOMAINS entry "${name}". Valid domains: ` +
          ALL_DOMAINS.join(", "),
      );
    }
    domainSet.add(name as ToolDomain);
  }
  return domainSet;
}
