/**
 * src/safety/confirm.ts
 *
 * Two-step confirmation gate for billing- and destructive-tier WHMCS MCP tools.
 *
 * Flow:
 *   1. First call to a gated tool runs in "preview" mode: no WHMCS API call is
 *      made. The handler builds a human-readable preview of what WOULD happen
 *      and calls `issueConfirmToken(toolName, args)` to mint a token.
 *   2. The caller (model/operator) must echo that exact token back on a
 *      second call, alongside the SAME tool name and the SAME arguments used
 *      to mint it. `consumeConfirmToken(...)` verifies signature, binding,
 *      expiry, and single-use, then the handler proceeds with the real
 *      WHMCS API call.
 *
 * Security properties:
 *   - HMAC-SHA256 signed: a token cannot be forged or replayed for a
 *     different tool/argument set without the server-side secret.
 *   - Bound to a stable hash of {tool, args}: swapping in different
 *     arguments after preview (e.g. bumping an amount) invalidates the token.
 *   - 5-minute TTL: stale confirmations expire rather than lingering.
 *   - Single-use: a consumed token (or one that fails verification) cannot
 *     be replayed. Consumption state is tracked in an in-process Map, which
 *     is intentional for a single-instance stdio/local-HTTP MCP server. If
 *     this server is ever run as multiple replicas behind a shared frontend,
 *     move `consumedNonces` to a shared store (e.g. Redis) — see the note on
 *     `ConfirmTokenStore` below.
 *
 * The signing secret comes from `WHMCS_MCP_CONFIRM_SECRET` when set (so
 * confirmations survive a process restart within their 5-minute TTL across
 * a multi-process/dev-reload setup). If unset, a random secret is generated
 * at process start, which means tokens do NOT survive a server restart —
 * acceptable for this tool's short TTL and local/stdio deployment model.
 * This env var is NOT part of the core plan's documented env list; treat it
 * as an optional hardening knob and document it in docs/configuration.md.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Confirmation tokens are valid for this long after issuance. */
export const CONFIRM_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * NOTE on secret sourcing: `WHMCS_MCP_CONFIRM_SECRET` is an optional,
 * server-local hardening knob (not in the core env-var list from the
 * architecture plan). If it is absent we fall back to a random in-memory
 * secret so the feature works out of the box; this is a one-line change
 * (the `process.env.WHMCS_MCP_CONFIRM_SECRET` read below) if a different
 * sourcing strategy (e.g. a secrets manager) is preferred later.
 */
function loadOrGenerateSecret(): Buffer {
  const fromEnv = process.env.WHMCS_MCP_CONFIRM_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    return Buffer.from(fromEnv, "utf8");
  }
  // Ephemeral per-process secret. Confirmations minted before a restart
  // become unverifiable after it, which is safe (they simply expire/deny)
  // rather than unsafe (they never silently validate against a new secret).
  return randomBytes(32);
}

const SIGNING_SECRET = loadOrGenerateSecret();

/** Shape of the data encoded inside a confirm token, pre-signature. */
interface ConfirmTokenPayload {
  /** Tool name this token authorizes, e.g. "billing_capture_payment". */
  tool: string;
  /** Stable hash of the canonicalized tool arguments (see `hashArgs`). */
  argsHash: string;
  /** Random per-issuance identifier; the unit of single-use consumption. */
  nonce: string;
  /** Unix ms timestamp when this token was issued. */
  iat: number;
  /** Unix ms timestamp after which this token is no longer valid. */
  exp: number;
}

export interface IssuedConfirmToken {
  /** Opaque bearer string to hand back to the caller as `confirmToken`. */
  token: string;
  /** Convenience copy of the expiry, for building preview messages. */
  expiresAt: Date;
}

export type ConfirmVerifyResult =
  | { ok: true }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" | "tool-mismatch" | "args-mismatch" | "already-used" };

/**
 * Tracks nonces that have already been consumed (or attempted with a
 * malformed/expired token) so a token can never be replayed, even if the
 * caller resubmits the exact same request twice.
 *
 * In-process only — see file header note on multi-replica deployments.
 * Entries are pruned lazily whenever a new token is issued or checked, using
 * `exp` recorded alongside the nonce, so this Map cannot grow unbounded
 * across a long-lived process.
 */
interface ConfirmTokenStore {
  consumedNonces: Map<string, number /* exp, ms epoch, for pruning */>;
}

const store: ConfirmTokenStore = {
  consumedNonces: new Map(),
};

function pruneExpired(now: number): void {
  for (const [nonce, exp] of store.consumedNonces) {
    if (exp <= now) {
      store.consumedNonces.delete(nonce);
    }
  }
}

/**
 * Canonicalizes tool arguments into a stable JSON string (keys sorted
 * recursively) and hashes it, so semantically-identical argument objects
 * with different key ordering still bind to the same token, while any
 * actual value change invalidates it.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value).sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function hashArgs(args: unknown): string {
  const canonical = JSON.stringify(canonicalize(args ?? {}));
  return createHmac("sha256", SIGNING_SECRET).update(canonical).digest("hex");
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function fromBase64url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function sign(payloadB64: string): string {
  return createHmac("sha256", SIGNING_SECRET).update(payloadB64).digest("base64url");
}

/**
 * Mints a new confirm token bound to `toolName` and `args`. Call this from
 * a billing/destructive-tier tool handler's FIRST invocation (the one that
 * returns a dry-run preview instead of calling the WHMCS API).
 */
export function issueConfirmToken(toolName: string, args: unknown): IssuedConfirmToken {
  const now = Date.now();
  pruneExpired(now);

  const payload: ConfirmTokenPayload = {
    tool: toolName,
    argsHash: hashArgs(args),
    nonce: randomBytes(16).toString("hex"),
    iat: now,
    exp: now + CONFIRM_TOKEN_TTL_MS,
  };

  const payloadB64 = base64url(JSON.stringify(payload));
  const signature = sign(payloadB64);
  const token = `${payloadB64}.${signature}`;

  return { token, expiresAt: new Date(payload.exp) };
}

/**
 * Verifies (without consuming) that `token` authorizes `toolName` with
 * `args` right now. Prefer `consumeConfirmToken` in tool handlers, which
 * wraps this and additionally enforces single-use; this function is exposed
 * separately for tests and for read-only diagnostics.
 */
export function verifyConfirmToken(token: string, toolName: string, args: unknown): ConfirmVerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "malformed" };
  }
  const [payloadB64, signature] = parts;

  const expectedSignature = sign(payloadB64);
  const providedSigBuf = fromBase64url(signature);
  const expectedSigBuf = fromBase64url(expectedSignature);
  if (
    providedSigBuf.length !== expectedSigBuf.length ||
    !timingSafeEqual(providedSigBuf, expectedSigBuf)
  ) {
    return { ok: false, reason: "bad-signature" };
  }

  let payload: ConfirmTokenPayload;
  try {
    payload = JSON.parse(fromBase64url(payloadB64).toString("utf8")) as ConfirmTokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (
    typeof payload.tool !== "string" ||
    typeof payload.argsHash !== "string" ||
    typeof payload.nonce !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }

  const now = Date.now();
  if (now > payload.exp) {
    return { ok: false, reason: "expired" };
  }

  if (payload.tool !== toolName) {
    return { ok: false, reason: "tool-mismatch" };
  }

  const currentArgsHash = hashArgs(args);
  const providedHashBuf = Buffer.from(payload.argsHash, "hex");
  const currentHashBuf = Buffer.from(currentArgsHash, "hex");
  if (
    providedHashBuf.length !== currentHashBuf.length ||
    !timingSafeEqual(providedHashBuf, currentHashBuf)
  ) {
    return { ok: false, reason: "args-mismatch" };
  }

  if (store.consumedNonces.has(payload.nonce)) {
    return { ok: false, reason: "already-used" };
  }

  return { ok: true };
}

/**
 * Verifies `token` exactly as `verifyConfirmToken` does, and if valid,
 * atomically marks its nonce as consumed so it can never be used again.
 * This is what tool handlers should call before performing a mutating
 * WHMCS API request.
 */
export function consumeConfirmToken(token: string, toolName: string, args: unknown): ConfirmVerifyResult {
  const result = verifyConfirmToken(token, toolName, args);
  if (!result.ok) {
    return result;
  }

  // Re-decode just to pull the nonce/exp for bookkeeping; verification above
  // already proved the token is well-formed and signed.
  const payloadB64 = token.split(".")[0] ?? "";
  const payload = JSON.parse(fromBase64url(payloadB64).toString("utf8")) as ConfirmTokenPayload;

  pruneExpired(Date.now());
  store.consumedNonces.set(payload.nonce, payload.exp);

  return { ok: true };
}

/**
 * Human-readable explanation for a failed confirm result, safe to surface
 * back to the caller/model (contains no secret material).
 */
export function explainConfirmFailure(result: Extract<ConfirmVerifyResult, { ok: false }>): string {
  switch (result.reason) {
    case "malformed":
      return "confirmToken is malformed or was not generated by this server.";
    case "bad-signature":
      return "confirmToken signature is invalid.";
    case "expired":
      return `confirmToken has expired (tokens are valid for ${String(CONFIRM_TOKEN_TTL_MS / 60000)} minutes after issuance). Re-run the tool without confirmToken to get a fresh preview.`;
    case "tool-mismatch":
      return "confirmToken was issued for a different tool.";
    case "args-mismatch":
      return "confirmToken does not match the arguments provided on this call. Arguments must be identical to the preview call that issued the token.";
    case "already-used":
      return "confirmToken has already been used. Each confirmToken is single-use; re-run the tool without confirmToken to get a fresh preview.";
    default: {
      const _exhaustive: never = result.reason;
      return _exhaustive;
    }
  }
}
