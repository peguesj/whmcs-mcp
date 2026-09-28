/**
 * src/safety/redact.ts
 *
 * Deep redaction for every value that leaves this server: tool results,
 * resource payloads, and error messages/stack traces. Nothing that has not
 * passed through `redactUnknown()` (or a narrower helper below) may be
 * written to stdout, returned to an MCP client, or logged to stderr.
 *
 * Scope:
 *  - WHMCS API credentials (identifier, secret, access key, session tokens)
 *  - Passwords and password-like fields (service passwords, admin passwords)
 *  - Payment data: card numbers, CVV/CVC, bank account/routing numbers,
 *    gateway tokens
 *  - Domain EPP/auth codes
 *  - Optionally, PII: email addresses, phone numbers, postal addresses
 *    (governed by WHMCS_MCP_REDACT_PII; defaults to true)
 *
 * This module has no knowledge of WHMCS action names. It redacts by *key
 * name* and, for a handful of high-confidence value shapes (PAN-like digit
 * runs, e-mail addresses), by *value pattern* as a defense-in-depth backstop
 * for fields the key-name list misses.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RedactOptions {
  /** Redact email addresses, phone numbers, and postal address fields. */
  redactPii: boolean;
  /** Replacement token used in place of a redacted value. */
  mask?: string;
}

const DEFAULT_MASK = "[REDACTED]";

/**
 * Reads WHMCS_MCP_REDACT_PII from the environment. Defaults to true
 * (redact PII) — this is a safety-by-default posture; callers running in a
 * trusted, single-operator context can opt out explicitly.
 */
export function defaultRedactOptions(): RedactOptions {
  const raw = process.env.WHMCS_MCP_REDACT_PII;
  const redactPii = raw === undefined ? true : !/^(0|false|no|off)$/i.test(raw.trim());
  return { redactPii, mask: DEFAULT_MASK };
}

// ---------------------------------------------------------------------------
// Key-based rules
// ---------------------------------------------------------------------------

/**
 * Field-name fragments (lowercase, matched with `includes`) that are always
 * redacted regardless of the PII setting: secrets, passwords, and payment
 * instrument data. These never belong in a model-visible response.
 */
const ALWAYS_REDACT_KEY_FRAGMENTS: readonly string[] = [
  // WHMCS API credentials / session material
  "secret",
  "apisecret",
  "accesskey",
  "api_access_key",
  "sessionid",
  "session_id",
  "authtoken",
  "auth_token",
  "identifier", // WHMCS API identifier: not secret-strength, but treated as
  // sensitive because it is a durable credential half; cheap to
  // redact, expensive to leak paired with a secret elsewhere in
  // the same log stream.

  // Passwords (client passwords, service/module passwords, admin passwords)
  "password",
  "password2",
  "pwd",
  "passwd",
  "servicepassword",
  "adminpassword",

  // Card / bank / payment data
  "cardnum",
  "cardnumber",
  "card_number",
  "cc_number",
  "ccnumber",
  "cvv",
  "cvv2",
  "cvc",
  "cardcvv",
  "securitycode",
  "expdate",
  "cardexpiry",
  "cardtype",
  "accountnumber",
  "account_number",
  "bankaccount",
  "bankaccountnumber",
  "routingnumber",
  "routing_number",
  "sortcode",
  "iban",
  "swift",
  "bic",
  "gatewaytoken",
  "gateway_token",
  "token", // catches paymethod tokens; broad, but tokens are bearer
  // credentials and false-positive redaction here is safe.

  // Domain transfer secrets
  "eppcode",
  "epp_code",
  "authcode",
  "auth_code",
  "transfercode",
];

/** Field-name fragments redacted only when `redactPii` is enabled. */
const PII_KEY_FRAGMENTS: readonly string[] = [
  "email",
  "phonenumber",
  "phone_number",
  "telephoneno",
  "address1",
  "address2",
  "postcode",
  "zipcode",
  "fullname",
  "firstname",
  "lastname",
  "companyname",
  "ipaddress", // client/admin IP; PII-adjacent, gated with the rest of PII
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function matchesAnyFragment(normalizedKey: string, fragments: readonly string[]): boolean {
  return fragments.some((fragment) => normalizedKey.includes(normalizeKey(fragment)));
}

/**
 * Whether a given object key should be redacted outright (value replaced
 * with the mask token rather than recursed into or pattern-scanned).
 */
export function isSensitiveKey(key: string, opts: RedactOptions = defaultRedactOptions()): boolean {
  const normalized = normalizeKey(key);
  if (matchesAnyFragment(normalized, ALWAYS_REDACT_KEY_FRAGMENTS)) return true;
  if (opts.redactPii && matchesAnyFragment(normalized, PII_KEY_FRAGMENTS)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Value-pattern rules (defense in depth for unlabeled or freeform strings —
// e.g. a support-ticket body that quotes a card number, or an error message
// that echoes a raw request parameter)
// ---------------------------------------------------------------------------

// 13-19 contiguous digits, optionally grouped by spaces or hyphens: a
// PAN-shaped run. Deliberately broad; false positives (e.g. a long invoice
// or phone number) are an acceptable cost for never leaking a real PAN.
const PAN_PATTERN = /\b(?:\d[ -]?){12,18}\d\b/g;

// CVV-labeled inline mentions ("cvv: 123", "cvv=123") that a key-based pass
// over a plain string (not an object) would otherwise miss.
const CVV_INLINE_PATTERN = /\b(cvv2?|cvc|security\s*code)\s*[:=]\s*\d{3,4}\b/gi;

const EMAIL_PATTERN = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

// Loose E.164-ish / punctuated phone number run (7-15 digits with optional
// separators). Only applied when PII redaction is on.
const PHONE_PATTERN = /\b(?:\+?\d[\d\-. ()]{6,14}\d)\b/g;

// EPP/auth codes are opaque alphanumeric strings; there is no reliable
// pattern to catch one in freeform text, so they rely entirely on the
// key-based rule (`eppcode`, `authcode`) above.

function redactValuePatterns(value: string, opts: RedactOptions): string {
  let out = value.replace(PAN_PATTERN, opts.mask ?? DEFAULT_MASK);
  out = out.replace(CVV_INLINE_PATTERN, (_match, label: string) => `${label}: ${opts.mask ?? DEFAULT_MASK}`);
  if (opts.redactPii) {
    out = out.replace(EMAIL_PATTERN, opts.mask ?? DEFAULT_MASK);
    out = out.replace(PHONE_PATTERN, opts.mask ?? DEFAULT_MASK);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deep redaction
// ---------------------------------------------------------------------------

const MAX_DEPTH = 12;

/**
 * Deeply redacts an arbitrary value (object, array, string, or primitive).
 * Safe to call on tool results, resource contents, or caught error payloads
 * before they reach a `console.error`, a logger, or an MCP response.
 */
export function redactUnknown(value: unknown, opts: RedactOptions = defaultRedactOptions(), depth = 0): unknown {
  if (depth >= MAX_DEPTH) return opts.mask ?? DEFAULT_MASK;

  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return redactValuePatterns(value, opts);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, opts, depth + 1));
  }

  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input)) {
      if (isSensitiveKey(key, opts)) {
        out[key] = val === null || val === undefined ? val : opts.mask ?? DEFAULT_MASK;
        continue;
      }
      out[key] = redactUnknown(val, opts, depth + 1);
    }
    return out;
  }

  // Functions, symbols, bigints, etc. — not expected in API payloads.
  return opts.mask ?? DEFAULT_MASK;
}

/**
 * Redacts a plain string (freeform text, an error's `.message`, a log line)
 * using only the value-pattern rules, since there are no object keys to
 * consult.
 */
export function redactString(value: string, opts: RedactOptions = defaultRedactOptions()): string {
  return redactValuePatterns(value, opts);
}

/**
 * Redacts an Error (or Error-shaped value) for safe logging/return: its
 * `message` and, if present, `stack` are pattern-redacted; any enumerable
 * extra properties (e.g. a WhmcsApiError's `.raw` payload) go through the
 * full deep redaction.
 */
export function redactError(err: unknown, opts: RedactOptions = defaultRedactOptions()): {
  name: string;
  message: string;
  stack?: string;
  [key: string]: unknown;
} {
  if (err instanceof Error) {
    const extras: Record<string, unknown> = {};
    for (const key of Object.keys(err)) {
      if (key === "message" || key === "stack" || key === "name") continue;
      extras[key] = redactUnknown((err as unknown as Record<string, unknown>)[key], opts);
    }
    return {
      name: err.name,
      message: redactString(err.message, opts),
      ...(err.stack ? { stack: redactString(err.stack, opts) } : {}),
      ...extras,
    };
  }
  if (typeof err === "string") {
    return { name: "Error", message: redactString(err, opts) };
  }
  return { name: "Error", message: redactString(String(err), opts), ...(typeof err === "object" && err ? (redactUnknown(err, opts) as Record<string, unknown>) : {}) };
}
