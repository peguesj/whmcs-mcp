#!/usr/bin/env node
/**
 * whmcs-bridge-mcp — entrypoint.
 *
 * Responsibilities:
 *  - Load and validate configuration (env vars, mode, enabled domains).
 *  - Construct the WHMCS API client (the sole network boundary).
 *  - Build the MCP server, registering tools/resources/prompts filtered by
 *    WHMCS_MCP_MODE (readonly | write | full) and WHMCS_MCP_ENABLE_DOMAINS.
 *  - Pick a transport: stdio by default, or Streamable HTTP (bound to
 *    127.0.0.1 only) when invoked with --http.
 *  - Handle graceful shutdown on SIGINT/SIGTERM and uncaught errors.
 *
 * This file intentionally contains no WHMCS network calls and no business
 * logic beyond wiring — the WhmcsClient (src/whmcs-client.ts) owns the HTTP
 * boundary, and each src/tools/<domain>.ts module owns its own tool
 * registrations. Keeping this file thin makes the safety/mode gating
 * auditable in one place (src/safety/policy.ts) rather than scattered
 * across tool modules.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Server as HttpServer } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";

import { loadConfig, type WhmcsMcpConfig } from "./config.js";
import { WhmcsClient } from "./whmcs-client.js";
import { logger } from "./logger.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { registerTools } from "./tools/registry.js";
import { registerCustomTools } from "./tools/custom.js";

// Every domain tool module registers its tools via `defineTool(...)` as a
// module-level side effect (see src/tools/registry.ts). Importing them here
// — purely for that side effect — populates the shared TOOL_REGISTRY before
// `registerTools(server, ctx)` runs below. Registration order does not
// encode any safety decision; src/safety/policy.ts is the single source of
// truth for what gets advertised under the active mode/domain config.
import "./tools/system.js";
import "./tools/tickets.js";
import "./tools/clients.js";
import "./tools/products.js";
import "./tools/invoices.js"; // billing tier gated: off unless WHMCS_MCP_MODE=full
import "./tools/domains.js";
import "./tools/orders.js";

const SERVER_NAME = "whmcs-mcp";
const SERVER_VERSION = "0.1.0";

function buildWhmcsClient(config: WhmcsMcpConfig): WhmcsClient {
  const secrets = config.getSecrets();
  return new WhmcsClient({
    apiUrl: config.apiUrl,
    identifier: secrets.identifier,
    secret: secrets.secret,
    ...(secrets.accessKey !== undefined ? { accessKey: secrets.accessKey } : {}),
    timeoutMs: config.timeoutMs,
    // WhmcsClient's token bucket is requests/second; config expresses the
    // operator-facing limit as requests/minute.
    rateLimitPerSecond: Math.max(1, Math.round(config.rateLimitPerMinute / 60)),
    allowInsecure: config.allowInsecure,
  });
}

function buildServer(config: WhmcsMcpConfig, client: WhmcsClient): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  // Operator-supplied custom tools (WHMCS_MCP_CUSTOM_TOOLS_FILE) register
  // via the same defineTool(...) call as every built-in domain module, so
  // they must run before registerTools(...) populates the McpServer.
  registerCustomTools({ logger });
  registerTools(server, { whmcs: client, config });

  registerResources(server, client, config);
  registerPrompts(server);

  return server;
}

async function startStdio(server: McpServer): Promise<() => Promise<void>> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`${SERVER_NAME} v${SERVER_VERSION} listening on stdio`);
  return async () => {
    await server.close();
  };
}

/**
 * Streamable HTTP transport, bound to 127.0.0.1 only — this server is never
 * intended to be exposed beyond the local machine. Each request gets a
 * fresh transport/session per the SDK's stateless-friendly pattern; sessions
 * are tracked by mcp-session-id so a client can still hold a long-lived
 * connection for server-initiated notifications.
 */
async function startHttp(
  server: McpServer,
  port: number,
): Promise<() => Promise<void>> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer: HttpServer = createHttpServer((req, res) => {
    void (async () => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      const existing =
        typeof sessionId === "string" ? transports.get(sessionId) : undefined;

      if (existing) {
        await existing.handleRequest(req, res);
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });

      transport.onclose = (): void => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      // StreamableHTTPServerTransport's `onclose` accessor is typed
      // `(() => void) | undefined`, which under this project's
      // `exactOptionalPropertyTypes` is not structurally assignable to the
      // base `Transport` interface's `onclose?: () => void` — a real SDK
      // typing quirk, not a design gap here. The runtime shape is a valid
      // Transport in every way the SDK actually uses.
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      logger.error("HTTP transport error", { error: (err as Error).message });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    }
    })();
  });

  await new Promise<void>((resolve) => {
    // Localhost-only bind, matching the operator's production-boundary
    // posture: this server never listens on a non-loopback interface.
    httpServer.listen(port, "127.0.0.1", resolve);
  });
  logger.info(`${SERVER_NAME} v${SERVER_VERSION} listening on http://127.0.0.1:${String(port)}`);

  return async () => {
    for (const transport of transports.values()) {
      await transport.close();
    }
    await server.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err); else resolve();
      });
    });
  };
}

function parseHttpPort(argv: string[]): number | undefined {
  const flagIndex = argv.indexOf("--http");
  if (flagIndex === -1) return undefined;
  const next = argv[flagIndex + 1];
  const parsed = next && !next.startsWith("-") ? Number(next) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3900;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const client = buildWhmcsClient(config);

  // Runtime version discovery/compat check (WhmcsDetails). Failures here are
  // logged, never fatal — the server still starts so read-only diagnosis is
  // possible even if the WHMCS API is briefly unreachable at boot.
  try {
    const details = await client.call<{ version?: string }>("WhmcsDetails");
    if (details.version) {
      logger.info(`Connected WHMCS reports version ${details.version}`);
    }
  } catch (err: unknown) {
    logger.warn("Startup WhmcsDetails check failed (continuing)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const server = buildServer(config, client);

  const httpPort = parseHttpPort(process.argv.slice(2));
  const shutdown =
    httpPort !== undefined
      ? await startHttp(server, httpPort)
      : await startStdio(server);

  let shuttingDown = false;
  const handleSignal = (signal: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down ${SERVER_NAME}`);
    shutdown()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error("Error during shutdown", { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", { reason: String(reason) });
  });
}

main().catch((err: unknown) => {
  // stdout is reserved for MCP stdio framing — never log to it.
  logger.error("Fatal startup error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
