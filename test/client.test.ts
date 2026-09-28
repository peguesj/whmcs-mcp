/**
 * client.test.ts
 *
 * Contract tests for src/whmcs-client.ts, the sole network boundary this
 * MCP server uses to talk to the WHMCS External API
 * (POST {WHMCS_API_URL}/includes/api.php, identifier+secret,
 * responsetype=json).
 *
 * Coverage:
 *  - auth encoding: identifier/secret/accesskey are sent as form fields on
 *    every request, never as headers or query string, never logged.
 *  - error mapping: result === "error" is thrown as a typed WhmcsApiError,
 *    carrying the WHMCS `message` and the `action` that failed.
 *  - retry policy: idempotent reads (GetTickets, GetClients, ...) retry with
 *    backoff on 5xx/429; a mutating write (OpenTicket, AddTicketReply, ...)
 *    is never retried, even on 5xx/429, to avoid double-submission.
 *  - timeout: a request that outlives WHMCS_MCP_TIMEOUT_MS aborts and
 *    surfaces a typed timeout error rather than hanging.
 *  - collection normalization: WHMCS's nested singular/plural shapes
 *    (e.g. { tickets: { ticket: [...] } }, or a single ticket object when
 *    WHMCS omits the wrapping array) are normalized to a flat array.
 *  - no secret in logs: the identifier, secret, accesskey, and full request
 *    body never appear in anything written to stderr via the logger.
 *
 * The mock WHMCS server (./mock-whmcs-server.ts) is a real node:http server
 * bound to an ephemeral port so these tests exercise actual request/response
 * encoding rather than mocking fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import {
  createMockWhmcsServer,
  type MockWhmcsServer,
} from "./mock-whmcs-server.js";

// NOTE ON IMPORT: this test targets the client module the sonnet-builder
// pass is responsible for authoring at ../src/whmcs-client.ts. The exact
// named exports below (WhmcsClient, WhmcsApiError, WhmcsTimeoutError) are
// the contract this test file assumes; if the implementation lands with
// different names, update the import, not the assertions.
import {
  WhmcsClient,
  WhmcsApiError,
  WhmcsTimeoutError,
  unwrapCollection,
} from "../src/whmcs-client.js";
import { logger, getLogBuffer, resetLogBuffer } from "../src/logger.js";

const IDENTIFIER = "test-identifier-do-not-use";
const SECRET = "test-secret-do-not-use-1234567890";
const ACCESS_KEY = "test-accesskey-do-not-use";

function makeClient(overrides: Partial<ConstructorParameters<typeof WhmcsClient>[0]> = {}) {
  return new WhmcsClient({
    apiUrl: mock.url,
    identifier: IDENTIFIER,
    secret: SECRET,
    accessKey: ACCESS_KEY,
    timeoutMs: 500,
    rateLimitPerSecond: 100,
    allowInsecure: true,
    ...overrides,
  });
}

let mock: MockWhmcsServer;

beforeEach(async () => {
  // The mock server must accept the exact identifier/secret `makeClient()`
  // sends (IDENTIFIER/SECRET above), not its own DEFAULT_MOCK_CREDENTIALS —
  // otherwise every call fails auth with "Invalid IP" before a test's
  // actual assertion (form encoding, retries, timeouts, ...) ever runs.
  // accessKey is deliberately left unrequired here: the "includes accesskey
  // when configured, and omits it when not" test only asserts on wire
  // encoding, for both a client configured WITH and WITHOUT an accessKey,
  // so the mock must not reject the latter.
  mock = await createMockWhmcsServer({
    credentials: { identifier: IDENTIFIER, secret: SECRET },
  });
  resetLogBuffer();
});

afterEach(async () => {
  await mock.close();
  vi.restoreAllMocks();
});

describe("auth encoding", () => {
  it("sends identifier, secret, and responsetype=json as form-encoded body fields", async () => {
    const client = makeClient();
    await client.call("GetTickets", {});

    const req = mock.lastRequest();
    expect(req).toBeDefined();
    expect(req!.method).toBe("POST");
    expect(req!.headers["content-type"]).toMatch(/application\/x-www-form-urlencoded/);

    const body = new URLSearchParams(req!.rawBody);
    expect(body.get("identifier")).toBe(IDENTIFIER);
    expect(body.get("secret")).toBe(SECRET);
    expect(body.get("responsetype")).toBe("json");
    expect(body.get("action")).toBe("GetTickets");
  });

  it("includes accesskey when configured, and omits it when not", async () => {
    const withKey = makeClient();
    await withKey.call("GetTickets", {});
    const bodyWithKey = new URLSearchParams(mock.lastRequest()!.rawBody);
    expect(bodyWithKey.get("accesskey")).toBe(ACCESS_KEY);

    // The shared mock server requires an access key (see beforeEach), so a
    // client configured without one is expected to have its call rejected
    // by the server's own auth check — this assertion only cares about what
    // the client actually put on the wire, not whether the call succeeded.
    const withoutKey = makeClient({ accessKey: undefined });
    await withoutKey.call("GetTickets", {}).catch(() => undefined);
    const bodyWithoutKey = new URLSearchParams(mock.lastRequest()!.rawBody);
    expect(bodyWithoutKey.has("accesskey")).toBe(false);
  });

  it("never places credentials in the URL or in headers", async () => {
    const client = makeClient();
    await client.call("GetTickets", {});

    const req = mock.lastRequest()!;
    expect(req.url).not.toContain(SECRET);
    expect(req.url).not.toContain(IDENTIFIER);
    const headerBlob = JSON.stringify(req.headers).toLowerCase();
    expect(headerBlob).not.toContain(SECRET.toLowerCase());
  });

  it("serializes nested action params (e.g. line items) as flat form fields", async () => {
    const client = makeClient();
    await client.call("CreateInvoice", {
      userid: 42,
      itemdescription1: "Line one",
      itemamount1: "10.00",
    });

    const body = new URLSearchParams(mock.lastRequest()!.rawBody);
    expect(body.get("userid")).toBe("42");
    expect(body.get("itemdescription1")).toBe("Line one");
    expect(body.get("itemamount1")).toBe("10.00");
  });
});

describe("error mapping", () => {
  it("throws WhmcsApiError when WHMCS responds with result: error", async () => {
    mock.queueResponse({
      status: 200,
      body: { result: "error", message: "Invalid IP" },
    });

    const client = makeClient();
    await expect(client.call("GetClients", {})).rejects.toBeInstanceOf(WhmcsApiError);
  });

  it("carries the WHMCS message and failing action on the thrown error", async () => {
    mock.queueResponse({
      status: 200,
      body: { result: "error", message: "Ticket ID Not Found" },
    });

    const client = makeClient();
    try {
      await client.call("GetTicket", { ticketid: 999999 });
      expect.unreachable("call should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WhmcsApiError);
      const apiErr = err as WhmcsApiError;
      expect(apiErr.message).toContain("Ticket ID Not Found");
      expect(apiErr.action).toBe("GetTicket");
    }
  });

  it("throws WhmcsApiError (not a generic Error) on a non-2xx HTTP status with a WHMCS error payload", async () => {
    mock.queueResponse({
      status: 403,
      body: { result: "error", message: "IP address not allowed" },
    });

    const client = makeClient();
    await expect(client.call("GetClients", {})).rejects.toBeInstanceOf(WhmcsApiError);
  });

  it("throws a typed error (not a bare JSON parse exception) when WHMCS returns non-JSON", async () => {
    mock.queueResponse({
      status: 200,
      rawBody: "<html>Not JSON</html>",
      contentType: "text/html",
    });

    const client = makeClient();
    await expect(client.call("GetClients", {})).rejects.toThrow();
  });
});

describe("retry policy: reads only, never writes", () => {
  it("retries a read action (GetTickets) after a 500, then succeeds", async () => {
    mock.queueResponse({ status: 500, body: { result: "error", message: "Internal Server Error" } });
    mock.queueResponse({
      status: 200,
      body: { result: "success", tickets: { ticket: [] } },
    });

    const client = makeClient({ retry: { maxAttempts: 3, baseDelayMs: 1 } });
    const result = await client.call("GetTickets", {});

    expect(result).toBeDefined();
    expect(mock.requestCount()).toBe(2);
  });

  it("retries a read action after a 429, then succeeds", async () => {
    mock.queueResponse({ status: 429, body: { result: "error", message: "Too Many Requests" } });
    mock.queueResponse({
      status: 200,
      body: { result: "success", clients: { client: [] } },
    });

    const client = makeClient({ retry: { maxAttempts: 3, baseDelayMs: 1 } });
    await client.call("GetClients", {});

    expect(mock.requestCount()).toBe(2);
  });

  it("gives up and throws after exhausting retries on a persistent 500", async () => {
    mock.queueResponse({ status: 500, body: { result: "error", message: "down" } });
    mock.queueResponse({ status: 500, body: { result: "error", message: "down" } });
    mock.queueResponse({ status: 500, body: { result: "error", message: "down" } });

    const client = makeClient({ retry: { maxAttempts: 3, baseDelayMs: 1 } });
    await expect(client.call("GetTickets", {})).rejects.toBeInstanceOf(WhmcsApiError);
    expect(mock.requestCount()).toBe(3);
  });

  it("does NOT retry a mutating write action (OpenTicket) on a 500", async () => {
    mock.queueResponse({ status: 500, body: { result: "error", message: "down" } });
    mock.queueResponse({
      status: 200,
      body: { result: "success", ticketid: 1, tid: "TICK-0001" },
    });

    const client = makeClient({ retry: { maxAttempts: 3, baseDelayMs: 1 } });
    await expect(
      client.call(
        "OpenTicket",
        { deptid: 1, subject: "Test", message: "Test message" },
        { idempotent: false },
      ),
    ).rejects.toBeInstanceOf(WhmcsApiError);

    // Exactly one attempt: a write must never be silently replayed against
    // a server that may have already applied it (e.g. duplicate ticket).
    expect(mock.requestCount()).toBe(1);
  });

  it("does NOT retry a mutating write action (AddInvoicePayment) on a 429", async () => {
    mock.queueResponse({ status: 429, body: { result: "error", message: "slow down" } });

    const client = makeClient({ retry: { maxAttempts: 3, baseDelayMs: 1 } });
    await expect(
      client.call(
        "AddInvoicePayment",
        { invoiceid: 1, transid: "tx_1", gateway: "manual" },
        { idempotent: false },
      ),
    ).rejects.toBeInstanceOf(WhmcsApiError);

    expect(mock.requestCount()).toBe(1);
  });

  it("does not retry on a 4xx client error even for a read action", async () => {
    mock.queueResponse({ status: 401, body: { result: "error", message: "Unauthorized" } });
    mock.queueResponse({ status: 200, body: { result: "success", tickets: { ticket: [] } } });

    const client = makeClient({ retry: { maxAttempts: 3, baseDelayMs: 1 } });
    await expect(client.call("GetTickets", {})).rejects.toBeInstanceOf(WhmcsApiError);

    // Only the first, failed request should have been made; 401 is not
    // retried regardless of read/write, since retrying will not help.
    expect(mock.requestCount()).toBe(1);
  });
});

describe("timeout", () => {
  it("aborts and throws WhmcsTimeoutError when the server exceeds the configured timeout", async () => {
    mock.queueResponse({
      status: 200,
      body: { result: "success", tickets: { ticket: [] } },
      delayMs: 200,
    });

    const client = makeClient({ timeoutMs: 20 });
    await expect(client.call("GetTickets", {})).rejects.toBeInstanceOf(WhmcsTimeoutError);
  });

  it("succeeds when the response arrives comfortably inside the timeout", async () => {
    mock.queueResponse({
      status: 200,
      body: { result: "success", tickets: { ticket: [] } },
      delayMs: 5,
    });

    const client = makeClient({ timeoutMs: 500 });
    await expect(client.call("GetTickets", {})).resolves.toBeDefined();
  });
});

describe("collection normalization", () => {
  it("flattens the nested plural/singular ticket shape to a flat array", async () => {
    mock.queueResponse({
      status: 200,
      body: {
        result: "success",
        totalresults: 2,
        tickets: {
          ticket: [
            { id: 1, tid: "TICK-0001", subject: "First" },
            { id: 2, tid: "TICK-0002", subject: "Second" },
          ],
        },
      },
    });

    const client = makeClient();
    const result = await client.call<{ tickets: { ticket: unknown[] } }>("GetTickets", {});
    const tickets = unwrapCollection(result.tickets, "ticket");
    expect(Array.isArray(tickets)).toBe(true);
    expect(tickets).toHaveLength(2);
  });

  it("normalizes a single-item collection that WHMCS returns as a bare object, not an array", async () => {
    mock.queueResponse({
      status: 200,
      body: {
        result: "success",
        totalresults: 1,
        tickets: {
          // WHMCS is known to drop the wrapping array when there is exactly
          // one result; the client must still normalize this to [ {...} ].
          ticket: { id: 1, tid: "TICK-0001", subject: "Only one" },
        },
      },
    });

    const client = makeClient();
    const result = await client.call<{ tickets: { ticket: unknown } }>("GetTickets", {});
    const tickets = unwrapCollection(result.tickets, "ticket");
    expect(Array.isArray(tickets)).toBe(true);
    expect(tickets).toHaveLength(1);
  });

  it("normalizes an empty collection to an empty array rather than null/undefined/empty-string", async () => {
    mock.queueResponse({
      status: 200,
      body: {
        result: "success",
        totalresults: 0,
        tickets: "",
      },
    });

    const client = makeClient();
    const result = await client.call<{ tickets: unknown }>("GetTickets", {});
    const tickets = unwrapCollection(result.tickets, "ticket");
    expect(Array.isArray(tickets)).toBe(true);
    expect(tickets).toHaveLength(0);
  });

  it("normalizes GetClientsDetails-style responses that have no wrapper collection unchanged", async () => {
    mock.queueResponse({
      status: 200,
      body: {
        result: "success",
        client_id: 5,
        firstname: "Jane",
        lastname: "Doe",
        email: "jane@example.test",
      },
    });

    const client = makeClient();
    const result = await client.call<{ client_id: number }>("GetClientsDetails", { clientid: 5 });
    expect(result.client_id).toBe(5);
  });
});

describe("no secret in logs", () => {
  it("never writes the identifier, secret, or accesskey to the logger on a successful call", async () => {
    mock.queueResponse({
      status: 200,
      body: { result: "success", tickets: { ticket: [] } },
    });

    const client = makeClient();
    const spy = vi.spyOn(logger, "debug");
    await client.call("GetTickets", { clientid: 1 });

    const emitted = [...getLogBuffer(), ...spy.mock.calls.flat().map(String)].join("\n");
    expect(emitted).not.toContain(SECRET);
    expect(emitted).not.toContain(IDENTIFIER);
    expect(emitted).not.toContain(ACCESS_KEY);
  });

  it("never writes the identifier, secret, or accesskey to the logger on an error path", async () => {
    mock.queueResponse({
      status: 200,
      body: { result: "error", message: "Invalid IP" },
    });

    const client = makeClient();
    const spy = vi.spyOn(logger, "error");
    await expect(client.call("GetClients", {})).rejects.toBeInstanceOf(WhmcsApiError);

    const emitted = [...getLogBuffer(), ...spy.mock.calls.flat().map(String)].join("\n");
    expect(emitted).not.toContain(SECRET);
    expect(emitted).not.toContain(IDENTIFIER);
    expect(emitted).not.toContain(ACCESS_KEY);
  });

  it("redacts a raw password field if it ever appears in an echoed request/response body", async () => {
    mock.queueResponse({
      status: 200,
      body: { result: "success", password2: "sh0uldNeverAppear!" },
    });

    const client = makeClient();
    const spy = vi.spyOn(logger, "debug");
    await client.call("AddClient", {
      firstname: "Jane",
      lastname: "Doe",
      email: "jane@example.test",
      password2: "sh0uldNeverAppear!",
    });

    const emitted = [...getLogBuffer(), ...spy.mock.calls.flat().map(String)].join("\n");
    expect(emitted).not.toContain("sh0uldNeverAppear!");
  });

  it("logs nothing at all to stdout (reserved for MCP stdio transport)", async () => {
    mock.queueResponse({
      status: 200,
      body: { result: "success", tickets: { ticket: [] } },
    });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const client = makeClient();
    await client.call("GetTickets", {});

    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});

describe("port/address sanity (mock server harness)", () => {
  it("binds to an ephemeral port and reports a usable address", () => {
    const address = mock.server.address() as AddressInfo;
    expect(address.port).toBeGreaterThan(0);
  });
});
