/**
 * config.ts — zod-validated environment loader for the WHMCS MCP server.
 *
 * Responsibilities:
 *  - Parse and validate every WHMCS_* / WHMCS_MCP_* env var with zod.
 *  - Refuse plaintext HTTP endpoints unless the operator explicitly opts in
 *    via WHMCS_MCP_ALLOW_INSECURE (local dev / test only).
 *  - Hold `identifier` / `secret` / `accessKey` behind a non-enumerable
 *    property so a stray `console.log(config)`, `JSON.stringify(config)`,
 *    or object-spread never leaks credentials into logs or tool output.
 *    (src/logger.ts and src/safety/redact.ts are defense-in-depth on top
 *    of this — this module is the first line.)
 *
 * This module performs no network I/O. src/whmcs-client.ts is the only
 * network boundary (see its file header for the WHMCS REST/External API
 * auth-header note).
 */

import { z } from "zod";

/** Tool advertisement tiers, from safest to most dangerous. */
export const TOOL_TIERS = ["read", "write", "billing", "destructive"] as const;
export type ToolTier = (typeof TOOL_TIERS)[number];

/** Server operating modes. Each mode is an allowlist of tiers it advertises. */
export const MCP_MODES = ["readonly", "write", "full"] as const;
export type McpMode = (typeof MCP_MODES)[number];

/**
 * Mode -> tier matrix. "readonly" (the default) advertises only read tools.
 * "write" adds write + destructive (still confirm-gated). "full" is required
 * to expose the billing tier at all — billing tools do not exist in the
 * tool list otherwise. See src/safety/policy.ts for the enforcement side.
 */
export const MODE_TIER_MATRIX: Record<McpMode, readonly ToolTier[]> = {
  readonly: ["read"],
  write: ["read", "write", "destructive"],
  full: ["read", "write", "destructive", "billing"],
};

/** All known tool domains, used to validate WHMCS_MCP_ENABLE_DOMAINS. */
export const TOOL_DOMAINS = [
  "system",
  "tickets",
  "clients",
  "products",
  "invoices",
  "domains",
  "orders",
] as const;
export type ToolDomain = (typeof TOOL_DOMAINS)[number];

const boolFromEnv = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v === "1" || v === "true" || v === "yes" || v === "on")
  .default("false" as unknown as boolean);

const csvDomains = z
  .string()
  .trim()
  .default(TOOL_DOMAINS.join(","))
  .transform((v) =>
    v
      .split(",")
      .map((d) => d.trim())
      .filter((d): d is ToolDomain =>
        (TOOL_DOMAINS as readonly string[]).includes(d),
      ),
  );

/** Public (safe-to-log) shape of the loaded config. Secrets are NOT here. */
const PublicConfigSchema = z.object({
  apiUrl: z
    .string()
    .trim()
    .min(1, "WHMCS_API_URL is required")
    .url("WHMCS_API_URL must be a valid URL")
    // The External API endpoint is a fixed path under the WHMCS install root
    // (e.g. https://billing.example.com). Callers may pass either the
    // install root or the full .../includes/api.php path; whmcs-client.ts
    // normalizes this.
    .refine((v) => {
      try {
        const u = new URL(v);
        return u.protocol === "https:" || u.protocol === "http:";
      } catch {
        return false;
      }
    }, "WHMCS_API_URL must use http(s)"),
  allowInsecure: boolFromEnv,
  mode: z.enum(MCP_MODES).default("readonly"),
  enabledDomains: csvDomains,
  redactPii: boolFromEnv.default("true" as unknown as boolean),
  timeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .max(300_000)
    .default(15_000),
  rateLimitPerMinute: z.coerce
    .number()
    .int()
    .positive()
    .max(6_000)
    .default(120),
});

export type PublicConfig = z.infer<typeof PublicConfigSchema>;

const SecretsSchema = z.object({
  identifier: z.string().trim().min(1, "WHMCS_API_IDENTIFIER is required"),
  secret: z.string().trim().min(1, "WHMCS_API_SECRET is required"),
  accessKey: z.string().trim().min(1).optional(),
});

type Secrets = z.infer<typeof SecretsSchema>;

/** Symbol key so the secrets holder does not show up in for...in / JSON. */
const SECRETS = Symbol("whmcs-mcp:secrets");

export interface WhmcsMcpConfig extends PublicConfig {
  /**
   * Non-enumerable accessor for credentials. Deliberately not a plain
   * property: `Object.keys(config)`, `{ ...config }`, and
   * `JSON.stringify(config)` will not include it, so an accidental log of
   * the whole config object cannot leak identifier/secret/accessKey.
   * Only src/whmcs-client.ts should call this.
   */
  getSecrets(): Readonly<Secrets>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function formatZodError(prefix: string, err: z.ZodError): string {
  const issues = err.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  return `${prefix}:\n${issues}`;
}

/**
 * Loads and validates configuration from `process.env` (or a supplied
 * env-like record, for testing). Throws ConfigError on any invalid or
 * missing required value — fail fast at startup, never at tool-call time.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WhmcsMcpConfig {
  const publicResult = PublicConfigSchema.safeParse({
    apiUrl: env.WHMCS_API_URL,
    allowInsecure: env.WHMCS_MCP_ALLOW_INSECURE,
    mode: env.WHMCS_MCP_MODE,
    enabledDomains: env.WHMCS_MCP_ENABLE_DOMAINS,
    redactPii: env.WHMCS_MCP_REDACT_PII,
    timeoutMs: env.WHMCS_MCP_TIMEOUT_MS,
    rateLimitPerMinute: env.WHMCS_MCP_RATE_LIMIT,
  });

  if (!publicResult.success) {
    throw new ConfigError(
      formatZodError("Invalid WHMCS MCP configuration", publicResult.error),
    );
  }

  const publicConfig = publicResult.data;

  // Enforce HTTPS unless the operator has explicitly opted into insecure
  // transport (local dev / mock-server testing only). This check lives
  // outside the zod schema because it depends on two fields together.
  const scheme = new URL(publicConfig.apiUrl).protocol;
  if (scheme === "http:" && !publicConfig.allowInsecure) {
    throw new ConfigError(
      "WHMCS_API_URL uses http(s) but is not https. Set WHMCS_MCP_ALLOW_INSECURE=true " +
        "to explicitly allow insecure transport (local/dev/mock only) — production " +
        "WHMCS deployments must use https.",
    );
  }

  const secretsResult = SecretsSchema.safeParse({
    identifier: env.WHMCS_API_IDENTIFIER,
    secret: env.WHMCS_API_SECRET,
    accessKey: env.WHMCS_API_ACCESS_KEY,
  });

  if (!secretsResult.success) {
    throw new ConfigError(
      formatZodError("Invalid or missing WHMCS API credentials", secretsResult.error),
    );
  }

  const secrets = secretsResult.data;
  const secretsHolder = { [SECRETS]: secrets } as {
    [SECRETS]: Secrets;
  };

  const config: WhmcsMcpConfig = {
    ...publicConfig,
    getSecrets(): Readonly<Secrets> {
      return secretsHolder[SECRETS];
    },
  };

  // Belt-and-suspenders: make getSecrets non-enumerable even though methods
  // defined via object literals are already non-enumerable-safe for
  // JSON.stringify (functions are dropped by JSON.stringify regardless).
  // The real risk is `identifier`/`secret` living as plain string
  // properties, which this design avoids entirely — they only ever exist
  // inside the SECRETS-keyed closure above, never as own enumerable keys
  // of `config`.
  Object.defineProperty(config, "getSecrets", {
    value: config.getSecrets,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze(config);
}

/** Convenience singleton for the common case of one process, one config. */
let cached: WhmcsMcpConfig | undefined;

export function getConfig(env: NodeJS.ProcessEnv = process.env): WhmcsMcpConfig {
  if (!cached) {
    cached = loadConfig(env);
  }
  return cached;
}

/** Test-only: clears the cached singleton so loadConfig() re-runs. */
export function __resetConfigCacheForTests(): void {
  cached = undefined;
}

/** True when `tier` is advertised under the config's current mode. */
export function isTierEnabled(config: Pick<WhmcsMcpConfig, "mode">, tier: ToolTier): boolean {
  return MODE_TIER_MATRIX[config.mode].includes(tier);
}

/** True when `domain` is in the configured enabled-domains list. */
export function isDomainEnabled(
  config: Pick<WhmcsMcpConfig, "enabledDomains">,
  domain: ToolDomain,
): boolean {
  return config.enabledDomains.includes(domain);
}
