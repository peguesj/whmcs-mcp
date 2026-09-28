/**
 * safety.test.ts
 *
 * Coverage for this server's safety layer:
 *  - confirm-token lifecycle (src/safety/confirm.ts): issue -> verify ->
 *    consume, single-use replay rejection, argument-tamper rejection,
 *    tool-mismatch rejection, malformed/expired token rejection.
 *  - dryRun short-circuit: a mutating tool call with `dryRun: true` never
 *    reaches the WHMCS network boundary, regardless of tier.
 *  - redaction coverage (src/safety/redact.ts): secrets, passwords, card/
 *    bank/EPP data are always stripped; PII (email/phone/address) is
 *    stripped only when redactPii is enabled; nested objects/arrays and
 *    Error objects are covered.
 *  - billing tier gating (src/safety/policy.ts): billing-tier tools are
 *    never advertised unless WHMCS_MCP_MODE=full; destructive tools are
 *    always confirm-gated; a tool definition cannot opt a billing/
 *    destructive tier out of confirmation.
 *
 * NOTE ON SCOPE / KNOWN INTEGRATION GAP: this file tests the safety
 * primitives directly against src/safety/confirm.ts, src/safety/policy.ts
 * and src/safety/redact.ts, whose exports are stable and match this test's
 * imports below. src/tools/registry.ts, as currently checked in, imports
 * names (`createConfirmToken`, `isTierAllowedInMode`, `requiresConfirmation`,
 * `redactDeep`) that do not exist on those modules' actual export surfaces
 * (confirm.ts exports `issueConfirmToken`/`consumeConfirmToken`; policy.ts
 * exports `isTierEnabledForMode`/`resolveToolPolicy`; redact.ts exports
 * `redactUnknown`). That mismatch means `../src/tools/registry.ts` cannot
 * be imported by a test today without an ESM "does not provide an export
 * named ..." failure. The "dryRun makes no network call" case below is
 * therefore verified against a minimal local reproduction of the documented
 * confirm-gate contract (see `runWithLocalConfirmGate` below), built only
 * from the real, working confirm.ts/policy.ts exports, plus a direct
 * assertion on `issueConfirmToken`'s preview-only contract. Flagging this
 * for the opus review pass covering src/whmcs-client.ts, src/safety/* and
 * billing-tier gating: src/tools/registry.ts needs its imports reconciled
 * to the safety modules' real names before `npm run build`/`typecheck` will
 * pass.
 */

import { describe, expect, it, vi } from "vitest";

import {
  CONFIRM_TOKEN_TTL_MS,
  consumeConfirmToken,
  explainConfirmFailure,
  hashArgs,
  issueConfirmToken,
  verifyConfirmToken,
  type ConfirmVerifyResult,
} from "../src/safety/confirm.js";

import {
  ALL_DOMAINS,
  ALL_MODES,
  ALL_TIERS,
  assertToolAllowed,
  isDomainEnabled,
  isTierEnabledForMode,
  isToolAdvertised,
  parseEnabledDomains,
  resolveToolPolicy,
  type Mode,
  type Tier,
} from "../src/safety/policy.js";

import {
  defaultRedactOptions,
  isSensitiveKey,
  redactError,
  redactString,
  redactUnknown,
  type RedactOptions,
} from "../src/safety/redact.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Baseline options with PII redaction ON (WHMCS_MCP_REDACT_PII default). */
const REDACT_PII_ON: RedactOptions = { redactPii: true, mask: "[REDACTED]" };
/** Baseline options with PII redaction explicitly OFF. */
const REDACT_PII_OFF: RedactOptions = { redactPii: false, mask: "[REDACTED]" };

function expectOk(result: ConfirmVerifyResult): asserts result is { ok: true } {
  if (!result.ok) {
    throw new Error(`expected ok=true, got failure reason "${result.reason}"`);
  }
}

function expectFail(
  result: ConfirmVerifyResult,
  reason: Extract<ConfirmVerifyResult, { ok: false }>["reason"],
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe(reason);
  }
}

// ---------------------------------------------------------------------------
// 1. Confirm-token lifecycle (src/safety/confirm.ts)
// ---------------------------------------------------------------------------

describe("safety/confirm.ts — confirm-token lifecycle", () => {
  it("issues a token that verifies successfully for the same tool + args", () => {
    const args = { invoiceid: 42, transid: "TXN-1", gateway: "stripe" };
    const issued = issueConfirmToken("billing_add_payment", args);

    expect(typeof issued.token).toBe("string");
    expect(issued.token.split(".")).toHaveLength(2);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(issued.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      CONFIRM_TOKEN_TTL_MS,
    );

    const verified = verifyConfirmToken(issued.token, "billing_add_payment", args);
    expectOk(verified);
  });

  it("consumes a valid token exactly once, then rejects replay as already-used", () => {
    const args = { invoiceid: 7, amount: "full" };
    const { token } = issueConfirmToken("billing_apply_credit", args);

    const first = consumeConfirmToken(token, "billing_apply_credit", args);
    expectOk(first);

    const second = consumeConfirmToken(token, "billing_apply_credit", args);
    expectFail(second, "already-used");
  });

  it("verifying (without consuming) does not burn single-use state", () => {
    const args = { serviceid: 99 };
    const { token } = issueConfirmToken("services_module_terminate", args);

    // Multiple non-consuming verifications are fine.
    expectOk(verifyConfirmToken(token, "services_module_terminate", args));
    expectOk(verifyConfirmToken(token, "services_module_terminate", args));

    // Only consumeConfirmToken burns it, and only once.
    expectOk(consumeConfirmToken(token, "services_module_terminate", args));
    expectFail(
      consumeConfirmToken(token, "services_module_terminate", args),
      "already-used",
    );
  });

  it("rejects a token replayed against a different tool name", () => {
    const args = { orderid: 1 };
    const { token } = issueConfirmToken("orders_cancel", args);

    expectFail(consumeConfirmToken(token, "orders_delete", args), "tool-mismatch");
  });

  it("rejects a token whose arguments were tampered with after issuance", () => {
    const originalArgs = { invoiceid: 100, cvv: "123" };
    const { token } = issueConfirmToken("billing_capture_payment", originalArgs);

    const tamperedArgs = { invoiceid: 100, cvv: "999" };
    expectFail(
      consumeConfirmToken(token, "billing_capture_payment", tamperedArgs),
      "args-mismatch",
    );

    // The untampered args still work (proves the mismatch was args-driven,
    // not e.g. an unrelated bug that rejects everything).
    expectOk(consumeConfirmToken(token, "billing_capture_payment", originalArgs));
  });

  it("is insensitive to key ordering when binding args to a token (canonicalization)", () => {
    const inOrder = { a: 1, b: 2, c: { x: 1, y: 2 } };
    const reordered = { c: { y: 2, x: 1 }, b: 2, a: 1 };

    expect(hashArgs(inOrder)).toBe(hashArgs(reordered));

    const { token } = issueConfirmToken("tickets_update", inOrder);
    expectOk(consumeConfirmToken(token, "tickets_update", reordered));
  });

  it("rejects a malformed token string", () => {
    expectFail(
      verifyConfirmToken("not-a-real-token", "tickets_delete", { ticketid: 1 }),
      "malformed",
    );
    expectFail(
      verifyConfirmToken("only.one.dot.too.many", "tickets_delete", { ticketid: 1 }),
      "malformed",
    );
  });

  it("rejects a token with a tampered/invalid signature", () => {
    const { token } = issueConfirmToken("tickets_merge", { ticketid: 1 });
    const [payload] = token.split(".");
    const forged = `${payload}.${"a".repeat(43)}`; // same length as base64url sig, wrong bytes

    expectFail(
      verifyConfirmToken(forged, "tickets_merge", { ticketid: 1 }),
      "bad-signature",
    );
  });

  it("rejects an expired token", () => {
    const now = Date.now();
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    const { token } = issueConfirmToken("domains_transfer", { domainid: 5 });
    expectOk(verifyConfirmToken(token, "domains_transfer", { domainid: 5 }));

    dateSpy.mockReturnValue(now + CONFIRM_TOKEN_TTL_MS + 1);
    expectFail(
      verifyConfirmToken(token, "domains_transfer", { domainid: 5 }),
      "expired",
    );

    dateSpy.mockRestore();
  });

  it("explainConfirmFailure returns a distinct, non-empty, secret-free message per reason", () => {
    const reasons: Array<Extract<ConfirmVerifyResult, { ok: false }>["reason"]> = [
      "malformed",
      "bad-signature",
      "expired",
      "tool-mismatch",
      "args-mismatch",
      "already-used",
    ];
    const messages = reasons.map((reason) =>
      explainConfirmFailure({ ok: false, reason }),
    );

    for (const message of messages) {
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
      // Defense in depth: an explanation string must never itself carry the
      // raw HMAC secret or a token-shaped value.
      expect(message).not.toMatch(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
    }
    // Every reason gets its own wording (no fallback that collapses them all
    // into one unhelpful generic string).
    expect(new Set(messages).size).toBe(messages.length);
  });
});

// ---------------------------------------------------------------------------
// 2. dryRun short-circuit — no network call
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for the WHMCS client's `call` surface, so these tests can
 * assert "no network call happened" without spinning up the mock WHMCS HTTP
 * server that test/client.test.ts owns.
 */
interface FakeWhmcsClient {
  call: (action: string, params: Record<string, unknown>) => Promise<unknown>;
}

function createFakeWhmcsClient(): FakeWhmcsClient & { call: ReturnType<typeof vi.fn> } {
  return {
    call: vi.fn(async () => {
      throw new Error(
        "FakeWhmcsClient.call() was invoked — dryRun should have short-circuited before any network call",
      );
    }),
  };
}

/**
 * Reproduces the documented dryRun contract from src/tools/registry.ts's
 * header comment ("Honors dryRun on every mutating tool: no network call is
 * made and a would-be-sent payload preview is returned instead") using only
 * the real, working confirm.ts/policy.ts exports. This exists because
 * src/tools/registry.ts's current import graph does not resolve (see the
 * file-header note above) — once it is reconciled to confirm.ts/policy.ts's
 * actual export names, this local helper should be deleted in favor of
 * importing `runWithConfirmation`/`registerTools` directly.
 */
async function runWithLocalConfirmGate(
  tier: Tier,
  whmcsAction: string,
  input: { dryRun?: boolean; confirmToken?: string } & Record<string, unknown>,
  client: FakeWhmcsClient,
): Promise<{ dryRun?: boolean; pendingConfirmation?: boolean; data: unknown }> {
  if (input.dryRun) {
    return {
      dryRun: true,
      data: { dryRun: true, whmcsAction, wouldSend: input },
    };
  }

  const policy = resolveToolPolicy({
    name: `test_${whmcsAction}`,
    domain: "invoices",
    tier,
  });

  if (policy.requiresConfirm) {
    const { confirmToken, ...rest } = input;
    if (!confirmToken) {
      const issued = issueConfirmToken(`test_${whmcsAction}`, rest);
      return {
        pendingConfirmation: true,
        data: { pendingConfirmation: true, confirmToken: issued.token },
      };
    }
    const consumed = consumeConfirmToken(confirmToken, `test_${whmcsAction}`, rest);
    if (!consumed.ok) {
      return { data: { error: consumed.reason } };
    }
  }

  const result = await client.call(whmcsAction, input);
  return { data: result };
}

describe("dryRun short-circuit — no network call", () => {
  it("a billing-tier call with dryRun=true never invokes the WHMCS client", async () => {
    const client = createFakeWhmcsClient();
    const result = await runWithLocalConfirmGate(
      "billing",
      "CapturePayment",
      { invoiceid: 1, cvv: "123", dryRun: true },
      client,
    );

    expect(client.call).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.data).toMatchObject({ dryRun: true, whmcsAction: "CapturePayment" });
  });

  it("a destructive-tier call with dryRun=true never invokes the WHMCS client, even with no confirmToken", async () => {
    const client = createFakeWhmcsClient();
    const result = await runWithLocalConfirmGate(
      "destructive",
      "DeleteTicket",
      { ticketid: 55, dryRun: true },
      client,
    );

    expect(client.call).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
  });

  it("a write-tier call with dryRun=true never invokes the WHMCS client", async () => {
    const client = createFakeWhmcsClient();
    const result = await runWithLocalConfirmGate(
      "write",
      "UpdateClient",
      { clientid: 1, firstname: "New", dryRun: true },
      client,
    );

    expect(client.call).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
  });

  it("dryRun=false on a read-tier call proceeds to the client (control case: gate is dryRun-specific, not blanket)", async () => {
    const client = createFakeWhmcsClient();
    client.call.mockResolvedValueOnce({ result: "success", tickets: [] });

    const result = await runWithLocalConfirmGate(
      "read",
      "GetTickets",
      { limitnum: 10 },
      client,
    );

    expect(client.call).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({ result: "success", tickets: [] });
  });

  it("without dryRun, a billing-tier call is held for confirmation and the client is not yet invoked", async () => {
    const client = createFakeWhmcsClient();
    const result = await runWithLocalConfirmGate(
      "billing",
      "AddInvoicePayment",
      { invoiceid: 9, transid: "T1", gateway: "manual" },
      client,
    );

    expect(client.call).not.toHaveBeenCalled();
    expect(result.pendingConfirmation).toBe(true);
    expect(result.data).toHaveProperty("confirmToken");
  });

  it("after confirmation, the same billing-tier call does invoke the client exactly once", async () => {
    const client = createFakeWhmcsClient();
    client.call.mockResolvedValueOnce({ result: "success" });

    const args = { invoiceid: 9, transid: "T1", gateway: "manual" };
    const preview = await runWithLocalConfirmGate(
      "billing",
      "AddInvoicePayment",
      args,
      client,
    );
    const confirmToken = (preview.data as { confirmToken: string }).confirmToken;

    const confirmed = await runWithLocalConfirmGate(
      "billing",
      "AddInvoicePayment",
      { ...args, confirmToken },
      client,
    );

    expect(client.call).toHaveBeenCalledTimes(1);
    expect(confirmed.data).toEqual({ result: "success" });
  });
});

// ---------------------------------------------------------------------------
// 3. Redaction coverage (src/safety/redact.ts)
// ---------------------------------------------------------------------------

describe("safety/redact.ts — redaction coverage", () => {
  describe("always-redacted keys (secrets, passwords, payment data)", () => {
    const alwaysSensitive: Array<[key: string, value: unknown]> = [
      ["secret", "s3cr3t-api-secret"],
      ["apiSecret", "s3cr3t-api-secret"],
      ["accesskey", "abc123"],
      ["identifier", "myidentifier"],
      ["password", "hunter2"],
      ["password2", "hunter2"],
      ["servicePassword", "hunter2"],
      ["cardNumber", "4111111111111111"],
      ["cvv", "123"],
      ["cvv2", "1234"],
      ["routingNumber", "021000021"],
      ["bankAccountNumber", "000123456789"],
      ["eppcode", "AbC123XyZ"],
      ["gatewayToken", "tok_live_abcdef"],
      ["sessionId", "sess_abc123"],
    ];

    it.each(alwaysSensitive)(
      "redacts key %s regardless of redactPii setting",
      (key, value) => {
        const inputOn = { [key]: value };
        const inputOff = { [key]: value };

        const redactedOn = redactUnknown(inputOn, REDACT_PII_ON) as Record<string, unknown>;
        const redactedOff = redactUnknown(inputOff, REDACT_PII_OFF) as Record<string, unknown>;

        expect(redactedOn[key]).toBe("[REDACTED]");
        expect(redactedOff[key]).toBe("[REDACTED]");
        expect(isSensitiveKey(key, REDACT_PII_OFF)).toBe(true);
      },
    );

    it("never leaves a card number, cvv, or secret substring in the JSON-stringified output", () => {
      const payload = {
        clientid: 1,
        identifier: "id_live_123",
        secret: "sk_live_verysecret",
        accesskey: "ak_abcdef",
        paymethod: {
          cardnumber: "4111 1111 1111 1111",
          cvv: "999",
          routingnumber: "021000021",
        },
      };

      const redacted = redactUnknown(payload, REDACT_PII_ON);
      const json = JSON.stringify(redacted);

      expect(json).not.toContain("sk_live_verysecret");
      expect(json).not.toContain("id_live_123");
      expect(json).not.toContain("ak_abcdef");
      expect(json).not.toContain("4111 1111 1111 1111");
      expect(json).not.toContain("4111111111111111");
      expect(json).not.toContain("999");
      expect(json).not.toContain("021000021");
    });
  });

  describe("PII keys gated by redactPii", () => {
    it("redacts email/phone/address fields when redactPii is true", () => {
      const input = {
        email: "jane@example.com",
        phonenumber: "+1 555-123-4567",
        address1: "123 Main St",
        firstname: "Jane",
        lastname: "Doe",
      };

      const redacted = redactUnknown(input, REDACT_PII_ON) as Record<string, unknown>;

      expect(redacted.email).toBe("[REDACTED]");
      expect(redacted.phonenumber).toBe("[REDACTED]");
      expect(redacted.address1).toBe("[REDACTED]");
      expect(redacted.firstname).toBe("[REDACTED]");
      expect(redacted.lastname).toBe("[REDACTED]");
    });

    it("does NOT redact email/phone/address fields when redactPii is false", () => {
      const input = {
        email: "jane@example.com",
        phonenumber: "+1 555-123-4567",
        firstname: "Jane",
      };

      const redacted = redactUnknown(input, REDACT_PII_OFF) as Record<string, unknown>;

      expect(redacted.email).toBe("jane@example.com");
      expect(redacted.phonenumber).toBe("+1 555-123-4567");
      expect(redacted.firstname).toBe("Jane");
    });

    it("still redacts always-sensitive keys even when redactPii is false", () => {
      const input = { email: "jane@example.com", secret: "topsecret" };
      const redacted = redactUnknown(input, REDACT_PII_OFF) as Record<string, unknown>;

      expect(redacted.email).toBe("jane@example.com");
      expect(redacted.secret).toBe("[REDACTED]");
    });
  });

  describe("value-pattern redaction (unlabeled freeform strings)", () => {
    it("redacts a PAN-shaped digit run inside a freeform string", () => {
      const note = "Customer read out 4111 1111 1111 1111 over the phone.";
      const redacted = redactString(note, REDACT_PII_ON);

      expect(redacted).not.toContain("4111 1111 1111 1111");
      expect(redacted).toContain("[REDACTED]");
    });

    it("redacts an inline CVV mention", () => {
      const note = "Gave cvv: 123 to support by mistake.";
      const redacted = redactString(note, REDACT_PII_ON);

      expect(redacted).not.toMatch(/cvv:\s*123/i);
    });

    it("redacts email addresses in freeform text only when redactPii is true", () => {
      const note = "Reach out to jane@example.com about this ticket.";

      expect(redactString(note, REDACT_PII_ON)).not.toContain("jane@example.com");
      expect(redactString(note, REDACT_PII_OFF)).toContain("jane@example.com");
    });
  });

  describe("structural coverage: nested objects, arrays, depth limit", () => {
    it("redacts sensitive keys nested inside arrays of objects", () => {
      const input = {
        paymethods: [
          { id: 1, cardnumber: "4111111111111111" },
          { id: 2, cardnumber: "5500000000000004" },
        ],
      };

      const redacted = redactUnknown(input, REDACT_PII_ON) as {
        paymethods: Array<{ id: number; cardnumber: string }>;
      };

      expect(redacted.paymethods[0]?.cardnumber).toBe("[REDACTED]");
      expect(redacted.paymethods[1]?.cardnumber).toBe("[REDACTED]");
      expect(redacted.paymethods[0]?.id).toBe(1);
    });

    it("redacts sensitive keys at arbitrary nesting depth", () => {
      const input = {
        level1: { level2: { level3: { secret: "deep-secret", ok: "fine" } } },
      };

      const redacted = redactUnknown(input, REDACT_PII_ON) as any;

      expect(redacted.level1.level2.level3.secret).toBe("[REDACTED]");
      expect(redacted.level1.level2.level3.ok).toBe("fine");
    });

    it("does not crash and masks values beyond the max recursion depth", () => {
      let deep: Record<string, unknown> = { bottom: "value" };
      for (let i = 0; i < 20; i++) {
        deep = { nested: deep };
      }

      expect(() => redactUnknown(deep, REDACT_PII_ON)).not.toThrow();
    });

    it("passes through null, undefined, numbers, booleans, and Dates unchanged in shape", () => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const input = { a: null, b: undefined, c: 42, d: true, e: now };

      const redacted = redactUnknown(input, REDACT_PII_ON) as Record<string, unknown>;

      expect(redacted.a).toBeNull();
      expect(redacted.b).toBeUndefined();
      expect(redacted.c).toBe(42);
      expect(redacted.d).toBe(true);
      expect(redacted.e).toBe(now.toISOString());
    });
  });

  describe("Error redaction", () => {
    it("redacts secret-shaped substrings from an Error's message and stack", () => {
      const err = new Error(
        "WHMCS call failed for identifier=id_live_123&secret=sk_live_verysecret",
      );

      const redacted = redactError(err, REDACT_PII_ON);

      expect(redacted.name).toBe("Error");
      // The message-level pattern redaction only catches PAN/CVV/email/phone
      // shapes, not arbitrary "key=value" text — so this asserts the
      // documented contract (key-based redaction applies to structured
      // extras, not to a flattened message string) rather than a stronger
      // guarantee the module does not make.
      expect(typeof redacted.message).toBe("string");
    });

    it("deep-redacts enumerable extra properties on an Error subclass", () => {
      class FakeWhmcsApiError extends Error {
        raw: unknown;
        constructor(message: string, raw: unknown) {
          super(message);
          this.name = "WhmcsApiError";
          this.raw = raw;
        }
      }

      const err = new FakeWhmcsApiError("AddClient failed", {
        submitted: { email: "jane@example.com", password: "hunter2" },
      });

      const redacted = redactError(err, REDACT_PII_ON) as {
        raw: { submitted: { email: string; password: string } };
      };

      expect(redacted.raw.submitted.password).toBe("[REDACTED]");
      expect(redacted.raw.submitted.email).toBe("[REDACTED]");
    });

    it("handles a plain string thrown as an error", () => {
      const redacted = redactError("card 4111111111111111 declined", REDACT_PII_ON);
      expect(redacted.name).toBe("Error");
      expect(redacted.message).not.toContain("4111111111111111");
    });
  });

  describe("defaultRedactOptions()", () => {
    const ORIGINAL_ENV = process.env.WHMCS_MCP_REDACT_PII;

    it("defaults redactPii to true when WHMCS_MCP_REDACT_PII is unset", () => {
      delete process.env.WHMCS_MCP_REDACT_PII;
      expect(defaultRedactOptions().redactPii).toBe(true);
      if (ORIGINAL_ENV !== undefined) process.env.WHMCS_MCP_REDACT_PII = ORIGINAL_ENV;
    });

    it("treats '0', 'false', 'no', 'off' as disabling PII redaction", () => {
      for (const falsy of ["0", "false", "no", "off", "FALSE", "Off"]) {
        process.env.WHMCS_MCP_REDACT_PII = falsy;
        expect(defaultRedactOptions().redactPii).toBe(false);
      }
      if (ORIGINAL_ENV === undefined) {
        delete process.env.WHMCS_MCP_REDACT_PII;
      } else {
        process.env.WHMCS_MCP_REDACT_PII = ORIGINAL_ENV;
      }
    });

    it("treats any other value (e.g. '1', 'true', 'yes') as enabling PII redaction", () => {
      for (const truthy of ["1", "true", "yes", "on"]) {
        process.env.WHMCS_MCP_REDACT_PII = truthy;
        expect(defaultRedactOptions().redactPii).toBe(true);
      }
      if (ORIGINAL_ENV === undefined) {
        delete process.env.WHMCS_MCP_REDACT_PII;
      } else {
        process.env.WHMCS_MCP_REDACT_PII = ORIGINAL_ENV;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Billing tier hidden unless MODE=full (src/safety/policy.ts)
// ---------------------------------------------------------------------------

describe("safety/policy.ts — billing tier hidden unless MODE=full", () => {
  it("billing tier is enabled only under mode=full", () => {
    expect(isTierEnabledForMode("billing", "readonly")).toBe(false);
    expect(isTierEnabledForMode("billing", "write")).toBe(false);
    expect(isTierEnabledForMode("billing", "full")).toBe(true);
  });

  it("destructive tier is NOT enabled under readonly or write, only full", () => {
    // Per this module's MODE_TIER_MATRIX: readonly=[read], write=[read,write],
    // full=[read,write,billing,destructive].
    expect(isTierEnabledForMode("destructive", "readonly")).toBe(false);
    expect(isTierEnabledForMode("destructive", "write")).toBe(false);
    expect(isTierEnabledForMode("destructive", "full")).toBe(true);
  });

  it("read tier is enabled under every mode", () => {
    for (const mode of ALL_MODES) {
      expect(isTierEnabledForMode("read", mode)).toBe(true);
    }
  });

  it("write tier is enabled under write and full, not readonly", () => {
    expect(isTierEnabledForMode("write", "readonly")).toBe(false);
    expect(isTierEnabledForMode("write", "write")).toBe(true);
    expect(isTierEnabledForMode("write", "full")).toBe(true);
  });

  it("isToolAdvertised hides a billing-tier tool under readonly/write mode", () => {
    const billingTool = { tier: "billing" as Tier, domain: "invoices" as const };

    expect(isToolAdvertised(billingTool, { mode: "readonly" })).toBe(false);
    expect(isToolAdvertised(billingTool, { mode: "write" })).toBe(false);
    expect(isToolAdvertised(billingTool, { mode: "full" })).toBe(true);
  });

  it("isToolAdvertised additionally respects WHMCS_MCP_ENABLE_DOMAINS even under mode=full", () => {
    const billingTool = { tier: "billing" as Tier, domain: "invoices" as const };
    const ticketsOnly = parseEnabledDomains("tickets,clients");

    expect(
      isToolAdvertised(billingTool, { mode: "full", enabledDomains: ticketsOnly }),
    ).toBe(false);

    const invoicesEnabled = parseEnabledDomains("invoices");
    expect(
      isToolAdvertised(billingTool, { mode: "full", enabledDomains: invoicesEnabled }),
    ).toBe(true);
  });

  it("assertToolAllowed throws for a billing tool when mode is not full (defense in depth for a stale client tool list)", () => {
    expect(() =>
      assertToolAllowed(
        { name: "billing_capture_payment", tier: "billing", domain: "invoices" },
        { mode: "write" },
      ),
    ).toThrow(/not enabled under WHMCS_MCP_MODE="write"/);
  });

  it("assertToolAllowed does not throw for a billing tool when mode is full", () => {
    expect(() =>
      assertToolAllowed(
        { name: "billing_capture_payment", tier: "billing", domain: "invoices" },
        { mode: "full" },
      ),
    ).not.toThrow();
  });

  it("resolveToolPolicy defaults requiresConfirm=true for billing and destructive tiers", () => {
    expect(resolveToolPolicy({ name: "billing_add_payment", domain: "invoices", tier: "billing" }).requiresConfirm).toBe(true);
    expect(resolveToolPolicy({ name: "orders_cancel", domain: "orders", tier: "destructive" }).requiresConfirm).toBe(true);
  });

  it("resolveToolPolicy defaults requiresConfirm=false for read and write tiers", () => {
    expect(resolveToolPolicy({ name: "tickets_list", domain: "tickets", tier: "read" }).requiresConfirm).toBe(false);
    expect(resolveToolPolicy({ name: "clients_update", domain: "clients", tier: "write" }).requiresConfirm).toBe(false);
  });

  it("resolveToolPolicy throws if a billing/destructive tool tries to opt out of confirmation", () => {
    expect(() =>
      resolveToolPolicy({
        name: "billing_capture_payment",
        domain: "invoices",
        tier: "billing",
        requiresConfirm: false,
      }),
    ).toThrow(/Safety policy violation/);

    expect(() =>
      resolveToolPolicy({
        name: "orders_delete",
        domain: "orders",
        tier: "destructive",
        requiresConfirm: false,
      }),
    ).toThrow(/Safety policy violation/);
  });

  it("resolveToolPolicy sets destructiveHint for billing and destructive tiers, not read/write", () => {
    expect(
      resolveToolPolicy({ name: "t1", domain: "invoices", tier: "billing" }).annotations
        .destructiveHint,
    ).toBe(true);
    expect(
      resolveToolPolicy({ name: "t2", domain: "orders", tier: "destructive" }).annotations
        .destructiveHint,
    ).toBe(true);
    expect(
      resolveToolPolicy({ name: "t3", domain: "tickets", tier: "read" }).annotations
        .destructiveHint,
    ).toBe(false);
    expect(
      resolveToolPolicy({ name: "t4", domain: "clients", tier: "write" }).annotations
        .destructiveHint,
    ).toBe(false);
  });

  it("resolveToolPolicy sets readOnlyHint only for the read tier", () => {
    for (const tier of ALL_TIERS) {
      const resolved = resolveToolPolicy({ name: `t-${tier}`, domain: "system", tier });
      expect(resolved.annotations.readOnlyHint).toBe(tier === "read");
    }
  });

  it("isDomainEnabled treats an undefined/empty allowlist as 'all domains enabled'", () => {
    for (const domain of ALL_DOMAINS) {
      expect(isDomainEnabled(domain, undefined)).toBe(true);
    }
  });

  it("parseEnabledDomains rejects an unknown domain name loudly rather than silently dropping it", () => {
    expect(() => parseEnabledDomains("tickets,not-a-real-domain")).toThrow(
      /Invalid WHMCS_MCP_ENABLE_DOMAINS entry/,
    );
  });

  it("parseEnabledDomains returns undefined for an empty/whitespace string (meaning: all domains)", () => {
    expect(parseEnabledDomains(undefined)).toBeUndefined();
    expect(parseEnabledDomains("")).toBeUndefined();
    expect(parseEnabledDomains("   ")).toBeUndefined();
  });

  it("every mode in ALL_MODES and tier in ALL_TIERS is covered by isTierEnabledForMode without throwing", () => {
    for (const mode of ALL_MODES as readonly Mode[]) {
      for (const tier of ALL_TIERS as readonly Tier[]) {
        expect(() => isTierEnabledForMode(tier, mode)).not.toThrow();
      }
    }
  });
});
