/**
 * WHMCS External API client.
 *
 * This is the ONLY network boundary in the MCP server. Every tool module
 * (src/tools/*.ts) calls through `WhmcsClient#call()` — nothing else in this
 * codebase is allowed to `fetch()` WHMCS directly.
 *
 * Transport: WHMCS "External API" (developers.whmcs.com/api-reference).
 * This is NOT a bearer-token REST API — WHMCS's external API is a single
 * endpoint, `{WHMCS_API_URL}/includes/api.php`, that accepts a
 * form-urlencoded POST body per call, where the `action` field selects the
 * operation (GetClients, AddTicketReply, etc). Auth is carried IN that body
 * via `identifier` + `secret` (an API Credentials pair created in
 * Setup > Staff Management > API Credentials), plus an optional `accesskey`
 * (a per-request access key configured in WHMCS General Settings > Security,
 * distinct from the identifier/secret pair). There is no Authorization
 * header in WHMCS's documented contract for this endpoint — do not add one.
 * This has been true since the External API's introduction in WHMCS 5.x and
 * is unchanged across 8.x and 9.0.x (verified against the current
 * developers.whmcs.com/api-reference for the actions this server implements).
 *
 * Version awareness: callers should invoke the `system_get_details` tool
 * (WhmcsDetails action) at startup / first use to confirm the connected
 * instance's `whmcs.version` and log a warning if it reports below 8.0 (see
 * docs/version-compatibility.md). This client does not gate on version
 * itself — it is a transport, not a policy layer.
 */

import { setTimeout as delay } from "node:timers/promises";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown whenever WHMCS's API responds with `result: "error"` (its uniform
 * failure envelope), or when the HTTP transport itself fails in a way that
 * cannot be retried. `action` and `message` are always safe to log; `raw` is
 * NOT logged by default (see redaction note on `call()`) because some WHMCS
 * error messages echo back submitted field values.
 */
export class WhmcsApiError extends Error {
  readonly action: string;
  /** WHMCS's own `message` field, when present. */
  readonly whmcsMessage: string | undefined;
  /** HTTP status code of the response, when the error originated post-HTTP. */
  readonly httpStatus: number | undefined;
  /** The raw parsed JSON body, kept off the `message` string for redaction. */
  readonly raw: unknown;

  constructor(params: {
    action: string;
    message: string;
    whmcsMessage?: string;
    httpStatus?: number;
    raw?: unknown;
  }) {
    super(params.message);
    this.name = "WhmcsApiError";
    this.action = params.action;
    this.whmcsMessage = params.whmcsMessage;
    this.httpStatus = params.httpStatus;
    this.raw = params.raw;
  }
}

/** Thrown when a request exceeds `WHMCS_MCP_TIMEOUT_MS`. */
export class WhmcsTimeoutError extends Error {
  readonly action: string;
  constructor(action: string, timeoutMs: number) {
    super(`WHMCS API call "${action}" timed out after ${timeoutMs}ms`);
    this.name = "WhmcsTimeoutError";
    this.action = action;
  }
}

/** Thrown by the local token-bucket limiter when it cannot admit a request. */
export class WhmcsRateLimitError extends Error {
  constructor(action: string) {
    super(`Local rate limit exceeded before calling WHMCS action "${action}"`);
    this.name = "WhmcsRateLimitError";
  }
}

// ---------------------------------------------------------------------------
// Config surface this module needs (kept minimal + duplicated-free from
// src/config.ts's richer shape so this file has no import-order coupling)
// ---------------------------------------------------------------------------

export interface WhmcsClientOptions {
  /** e.g. "https://billing.example.com" — no trailing slash, no /includes suffix. */
  apiUrl: string;
  identifier: string;
  secret: string;
  /** Optional WHMCS "Access Key" (General Settings > Security > API IP Access Restriction). */
  accessKey?: string;
  /** Default 15000ms. */
  timeoutMs?: number;
  /** Token-bucket capacity AND refill rate in requests/second. Default 5. */
  rateLimitPerSecond?: number;
  /** Max attempts for idempotent (read) actions on 429/5xx. Default 3. */
  maxReadRetries?: number;
  /** Allow http:// (non-TLS) apiUrl. Default false — production must use https. */
  allowInsecure?: boolean;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Action classification
// ---------------------------------------------------------------------------

/**
 * WHMCS actions that are pure reads. Only these are retried automatically on
 * transient failure — retrying a write (OpenTicket, AddInvoicePayment, ...)
 * risks duplicating a side effect, so writes get exactly one attempt from
 * this client. This list mirrors the toolList's `[read]`-tier actions from
 * the architecture plan; keep it in sync when new read tools are added.
 */
const READ_ONLY_ACTIONS = new Set<string>([
  "WhmcsDetails",
  "GetStats",
  "GetActivityLog",
  "GetAdminDetails",
  "GetToDoItems",
  "GetEmailTemplates",
  "GetPaymentMethods",
  "GetCurrencies",
  "GetTickets",
  "GetTicket",
  "GetTicketNotes",
  "GetTicketAttachment",
  "GetTicketCounts",
  "GetSupportDepartments",
  "GetSupportStatuses",
  "GetTicketPredefinedReplies",
  "GetClients",
  "GetClientsDetails",
  "GetContacts",
  "GetEmails",
  "GetClientGroups",
  "GetClientsProducts",
  "GetClientsAddons",
  "GetProducts",
  "GetPromotions",
  "GetInvoices",
  "GetInvoice",
  "GetCredits",
  "GetTransactions",
  "GetPayMethods",
  "GetQuotes",
  "GetClientsDomains",
  "DomainWhois",
  "DomainGetNameservers",
  "DomainGetLockingStatus",
  "DomainGetWhoisInfo",
  "GetTLDPricing",
  "GetOrders",
  "GetOrderStatuses",
]);

export function isReadOnlyAction(action: string): boolean {
  return READ_ONLY_ACTIONS.has(action);
}

// ---------------------------------------------------------------------------
// Token-bucket rate limiter (in-process; one bucket per WhmcsClient instance)
// ---------------------------------------------------------------------------

class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private lastRefill: number;

  constructor(ratePerSecond: number) {
    this.capacity = Math.max(1, ratePerSecond);
    this.tokens = this.capacity;
    this.refillPerMs = this.capacity / 1000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  /** Waits (async, cooperative) until a token is available, then consumes one. */
  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const msPerToken = 1 / this.refillPerMs;
      await delay(Math.min(250, Math.ceil(msPerToken)));
    }
  }
}

// ---------------------------------------------------------------------------
// Response shape normalization
// ---------------------------------------------------------------------------

/**
 * WHMCS wraps repeating collections in an extra singular-named layer, e.g.
 * `{ tickets: { ticket: [...] } }` or, worse, `{ tickets: { ticket: {...} } }`
 * when exactly one row comes back (WHMCS drops the array in that case for
 * several actions). `unwrapCollection` normalizes both shapes to an array so
 * every tool module gets a consistent `T[]`, never a bare `T`.
 *
 * @param container The parent object, e.g. `parsed.tickets`.
 * @param itemKey The singular key holding the row(s), e.g. "ticket".
 */
export function unwrapCollection<T>(container: unknown, itemKey: string): T[] {
  if (container == null || typeof container !== "object") return [];
  const inner = (container as Record<string, unknown>)[itemKey];
  if (inner == null) return [];
  if (Array.isArray(inner)) return inner as T[];
  return [inner as T];
}

// ---------------------------------------------------------------------------
// WhmcsClient
// ---------------------------------------------------------------------------

export interface WhmcsCallParams {
  [key: string]: string | number | boolean | undefined | null;
}

/** Successful-envelope shape common to every WHMCS External API action. */
export interface WhmcsRawResponse {
  result?: string;
  message?: string;
  [key: string]: unknown;
}

export class WhmcsClient {
  private readonly endpoint: string;
  private readonly identifier: string;
  private readonly secret: string;
  private readonly accessKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxReadRetries: number;
  private readonly bucket: TokenBucket;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WhmcsClientOptions) {
    const base = opts.apiUrl.replace(/\/+$/, "");
    if (!/^https:\/\//i.test(base) && !opts.allowInsecure) {
      throw new Error(
        "WHMCS_API_URL must be https:// unless WHMCS_MCP_ALLOW_INSECURE is set (never do this against production).",
      );
    }
    this.endpoint = `${base}/includes/api.php`;
    this.identifier = opts.identifier;
    this.secret = opts.secret;
    this.accessKey = opts.accessKey;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxReadRetries = opts.maxReadRetries ?? 3;
    this.bucket = new TokenBucket(opts.rateLimitPerSecond ?? 5);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Executes one WHMCS External API action and returns its parsed JSON body.
   *
   * - Always POSTs form-urlencoded (`application/x-www-form-urlencoded`),
   *   per the documented contract; WHMCS's API does not accept JSON bodies.
   * - Injects `identifier`, `secret`, `accesskey` (if configured) and
   *   `responsetype=json` into every request — callers never pass these.
   * - Retries only when `action` is in `READ_ONLY_ACTIONS`, and only on
   *   HTTP 429/5xx or a network-level failure, with capped exponential
   *   backoff (250ms, 500ms, 1000ms, ...). Writes get exactly one attempt.
   * - Never logs the request body (it contains `secret`) or the raw response
   *   body (WHMCS error messages can echo submitted values, which may
   *   include PII). Callers that need to log should log `error.action` and
   *   `error.whmcsMessage` from a caught `WhmcsApiError`, not `error.raw`.
   */
  async call<T extends WhmcsRawResponse = WhmcsRawResponse>(
    action: string,
    params: WhmcsCallParams = {},
  ): Promise<T> {
    const retryable = isReadOnlyAction(action);
    const attempts = retryable ? this.maxReadRetries : 1;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.bucket.acquire();
      try {
        return await this.performOne<T>(action, params);
      } catch (err) {
        lastError = err;
        const shouldRetry =
          retryable &&
          attempt < attempts &&
          err instanceof WhmcsApiError &&
          typeof err.httpStatus === "number" &&
          (err.httpStatus === 429 || err.httpStatus >= 500);
        if (!shouldRetry) throw err;
        const backoffMs = 250 * 2 ** (attempt - 1);
        await delay(backoffMs);
      }
    }
    // Unreachable in practice (loop always returns or throws), but keeps TS
    // happy about a guaranteed return/throw and preserves the last error.
    throw lastError instanceof Error
      ? lastError
      : new WhmcsApiError({ action, message: "WHMCS API call failed for an unknown reason" });
  }

  private async performOne<T extends WhmcsRawResponse>(
    action: string,
    params: WhmcsCallParams,
  ): Promise<T> {
    const body = new URLSearchParams();
    body.set("action", action);
    body.set("identifier", this.identifier);
    body.set("secret", this.secret);
    if (this.accessKey) body.set("accesskey", this.accessKey);
    body.set("responsetype", "json");
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      body.set(key, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let httpResponse: Response;
    try {
      httpResponse = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new WhmcsTimeoutError(action, this.timeoutMs);
      }
      throw new WhmcsApiError({
        action,
        message: `Network error calling WHMCS action "${action}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!httpResponse.ok) {
      // Read the body for potential retry classification, but never
      // surface it verbatim (see class doc on `raw`).
      let raw: unknown;
      try {
        raw = await httpResponse.json();
      } catch {
        raw = undefined;
      }
      throw new WhmcsApiError({
        action,
        message: `WHMCS API HTTP ${httpResponse.status} for action "${action}"`,
        httpStatus: httpResponse.status,
        raw,
      });
    }

    let parsed: T;
    try {
      parsed = (await httpResponse.json()) as T;
    } catch (err) {
      throw new WhmcsApiError({
        action,
        message: `WHMCS API returned non-JSON for action "${action}" (unexpected — check responsetype and WHMCS_API_URL)`,
      });
    }

    if (parsed.result === "error") {
      throw new WhmcsApiError({
        action,
        message: `WHMCS API error on action "${action}": ${parsed.message ?? "(no message)"}`,
        whmcsMessage: parsed.message,
        httpStatus: httpResponse.status,
        raw: parsed,
      });
    }

    return parsed;
  }
}
