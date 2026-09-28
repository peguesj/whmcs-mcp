/**
 * src/logger.ts
 *
 * Stderr-only structured logger for the WHMCS MCP server.
 *
 * MCP over stdio uses stdout exclusively for the JSON-RPC message stream.
 * Any stray byte written to stdout (a console.log, a library's default
 * logger, a stray print) corrupts the protocol framing and can silently
 * break the client connection. This logger therefore NEVER writes to
 * stdout — every level, including info and debug, goes to stderr via
 * `process.stderr.write`.
 *
 * It also runs redaction on every field before serialization, so a caller
 * that accidentally logs a WHMCS API secret, a card number, or a client
 * password never gets it onto the wire (stderr can still end up in a
 * captured log file, a terminal transcript, or an aggregator).
 *
 * This file is deliberately dependency-free (no import from
 * src/safety/redact.ts) so the logger can be used from anywhere in the
 * codebase — including inside the safety layer itself — without a
 * circular-import risk. If src/safety/redact.ts exists and exposes a
 * more thorough `redactValue`/`redactString`, prefer wiring it in there;
 * the patterns below are intentionally a conservative, self-contained
 * subset covering the same categories (secrets, passwords, card/bank
 * data, CVV, EPP codes) used across the tool and client layers.
 */

/* ------------------------------------------------------------------ */
/* Log levels                                                          */
/* ------------------------------------------------------------------ */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveMinLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = (env.WHMCS_MCP_LOG_LEVEL ?? "info").toLowerCase().trim();
  return (LOG_LEVELS as readonly string[]).includes(raw)
    ? (raw as LogLevel)
    : "info";
}

/* ------------------------------------------------------------------ */
/* Redaction                                                            */
/* ------------------------------------------------------------------ */

/**
 * Object keys whose values are always replaced with a fixed placeholder,
 * regardless of shape, matched case-insensitively against the last path
 * segment. Mirrors the categories the WHMCS External API can return or
 * accept: auth secrets, account passwords/service credentials, payment
 * instrument data, and domain transfer (EPP) codes.
 */
const REDACT_KEY_PATTERN =
  /(secret|password|passwd|pwd|api[_-]?key|access[_-]?key|accesskey|token|authoriz(?:e|ation)|cvv|cvc|card(?:no|number)?|cc(?:no|number)|eppcode|epp_code|servicepassword|dbpassword|ssn|routingnumber|accountnumber)/i;

/** Placeholder written in place of a redacted value. */
const REDACTED = "[REDACTED]";

/** Matches a run of 12-19 digits, optionally grouped by spaces/dashes (PAN-shaped). */
const CARD_NUMBER_PATTERN = /\b(?:\d[ -]?){12,19}\b/g;

/** Matches an `identifier:secret`-style WHMCS Basic-style credential pair inline in text. */
const INLINE_SECRET_ASSIGNMENT_PATTERN =
  /((?:secret|password|api[_-]?key|access[_-]?key|token)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

function redactString(value: string): string {
  let out = value.replace(
    INLINE_SECRET_ASSIGNMENT_PATTERN,
    (_m, prefix: string) => `${prefix}${REDACTED}`,
  );
  out = out.replace(CARD_NUMBER_PATTERN, REDACTED);
  return out;
}

const MAX_REDACT_DEPTH = 8;

/**
 * Deep-clones and redacts a value for safe logging. Handles objects,
 * arrays, Errors (message + stack are string-redacted, other enumerable
 * fields recurse), Maps/Sets (stringified), and primitives. Circular
 * references are broken with a `[Circular]` marker rather than throwing.
 */
export function redactForLog(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (depth >= MAX_REDACT_DEPTH) return "[Truncated]";

  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
      ...Object.fromEntries(
        Object.entries(value as unknown as Record<string, unknown>).filter(
          ([k]) => k !== "message" && k !== "stack" && k !== "name",
        ),
      ),
    };
  }

  if (typeof value !== "object") return value;

  const obj = value as object;
  if (seen.has(obj)) return "[Circular]";
  seen.add(obj);

  if (Array.isArray(value)) {
    return value.map((entry) => redactForLog(entry, seen, depth + 1));
  }

  if (value instanceof Map) {
    return redactForLog(Object.fromEntries(value.entries()), seen, depth + 1);
  }
  if (value instanceof Set) {
    return Array.from(value.values()).map((entry) => redactForLog(entry, seen, depth + 1));
  }
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_KEY_PATTERN.test(key) ? REDACTED : redactForLog(val, seen, depth + 1);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Structured log record                                               */
/* ------------------------------------------------------------------ */

export interface LogFields {
  [key: string]: unknown;
}

interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  component?: string;
  [key: string]: unknown;
}

function writeStderr(record: LogRecord): void {
  // Single synchronous write, newline-delimited JSON, stderr only.
  // Never touch process.stdout — that stream is reserved for the MCP
  // JSON-RPC transport (StdioServerTransport).
  try {
    process.stderr.write(`${JSON.stringify(record)}\n`);
  } catch {
    // Last-resort fallback if a value survived redaction but still fails
    // to serialize (e.g. a BigInt slipped through). Never throw from the
    // logger — a logging failure must not crash the server.
    try {
      process.stderr.write(
        `${JSON.stringify({ ts: record.ts, level: record.level, msg: "[log serialization failed]" })}\n`,
      );
    } catch {
      /* give up silently */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Logger                                                               */
/* ------------------------------------------------------------------ */

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a child logger that merges `bindings` into every record. */
  child(bindings: LogFields): Logger;
}

function makeLogger(component: string | undefined, bindings: LogFields, env: NodeJS.ProcessEnv): Logger {
  const minLevel = resolveMinLevel(env);

  function log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;

    const merged = { ...bindings, ...(fields ?? {}) };
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      msg: redactString(msg),
      ...(component ? { component } : {}),
      ...(redactForLog(merged) as Record<string, unknown>),
    };
    writeStderr(record);
  }

  return {
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
    child: (childBindings) => makeLogger(component, { ...bindings, ...childBindings }, env),
  };
}

/**
 * Root logger. Reads WHMCS_MCP_LOG_LEVEL (debug|info|warn|error, default
 * "info") at construction time via `process.env`; callers that need a
 * custom env source (tests) should use `createLogger` directly.
 */
export const logger: Logger = makeLogger(undefined, {}, process.env);

/**
 * Creates a standalone logger, optionally scoped to a component name
 * (e.g. "whmcs-client", "tools/tickets", "safety/confirm") and/or a
 * custom env source for testing.
 */
export function createLogger(component?: string, env: NodeJS.ProcessEnv = process.env): Logger {
  return makeLogger(component, {}, env);
}
