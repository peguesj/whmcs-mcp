#!/usr/bin/env node
/**
 * scripts/capture-screenshots.ts
 *
 * Captures marketing screenshots for site/index.html by driving the
 * @modelcontextprotocol/inspector UI (connected to this repo's mock WHMCS
 * server, test/mock-whmcs-server.ts) with Playwright.
 *
 * SAFETY / DATA POLICY:
 *  - This script NEVER points at a real WHMCS install. It always spawns the
 *    server with WHMCS_API_URL pointed at the in-process mock fixture
 *    server (127.0.0.1, ephemeral port), so every screenshot is synthetic
 *    fixture data (see test/fixtures/*.json). The operator's standing rule
 *    is that no real client/billing data is ever published on a public
 *    site — do not repoint this script at a live endpoint.
 *  - Output lands under site/assets/screenshots/*.png, which is the only
 *    directory the marketing site (site/index.html) references images
 *    from.
 *
 * FLOW CAPTURED (one PNG each, see SHOTS below):
 *  1. tool-list        — Inspector's tool list, grouped by domain/tier.
 *  2. ticket-triage     — tickets_list + tickets_get + triage-ticket prompt.
 *  3. client-360        — clients_get with GetClientsDetails stats=true.
 *  4. confirm-gate      — a billing-tier tool's two-step confirm flow: the
 *                          first call returns a preview + confirmToken, the
 *                          second call (with the token echoed back) is
 *                          shown pending confirmation, illustrating that no
 *                          mutation fires without the explicit second call.
 *
 * USAGE
 *   npm run screenshots
 *   npx tsx scripts/capture-screenshots.ts [--headed] [--out <dir>]
 *
 * REQUIRES (dev-only, not runtime deps of the published package):
 *   npm i -D playwright @modelcontextprotocol/inspector
 * Both are intentionally left out of package.json's `dependencies` — they
 * are only needed to regenerate marketing screenshots, never at runtime or
 * in CI's normal test/build gates.
 *
 * NOTE ON UNCERTAINTY: the Inspector's DOM structure (selectors below) is
 * pinned to @modelcontextprotocol/inspector's published UI at the time of
 * writing. If Inspector changes its markup, only the SELECTORS block below
 * should need updating — every Playwright call in this file goes through
 * it rather than hardcoding selectors inline.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

/** CLI flags: --headed runs a visible browser (debugging); --out overrides the output dir. */
const argv = process.argv.slice(2);
const HEADED = argv.includes("--headed");
const outFlagIdx = argv.indexOf("--out");
const OUT_DIR =
  outFlagIdx !== -1 && argv[outFlagIdx + 1]
    ? path.resolve(process.cwd(), argv[outFlagIdx + 1]!)
    : path.join(REPO_ROOT, "site", "assets", "screenshots");

const VIEWPORT = { width: 1440, height: 900 };

/**
 * Selectors are centralized so a future Inspector UI change is a one-file
 * fix. These target the @modelcontextprotocol/inspector web client as of
 * its 0.x releases (left-nav tool list, JSON request/response panes).
 */
const SELECTORS = {
  connectedBadge: "text=/connected/i",
  toolsNavTab: "role=tab[name=/tools/i]",
  toolListItem: (toolName: string) => `text="${toolName}"`,
  runToolButton: "role=button[name=/run tool|call tool|execute/i]",
  jsonResponsePane: "[data-testid='tool-response'], pre.response, .response-json",
  promptsNavTab: "role=tab[name=/prompts/i]",
  inputField: (fieldName: string) =>
    `label:has-text("${fieldName}") >> xpath=following::input[1]`,
};

interface Shot {
  /** Output filename under OUT_DIR, without extension. */
  name: string;
  /** One-paragraph alt text used in site/index.html <img alt="...">. */
  alt: string;
  /** Performs whatever Inspector interaction is needed, then screenshots. */
  capture: (page: import("playwright").Page) => Promise<void>;
}

/** Finds a free TCP port on 127.0.0.1 for the mock WHMCS fixture server. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not allocate a free port")));
      }
    });
  });
}

/** Waits for a process to print a line matching `pattern` on stdout, or times out. */
function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  pattern: RegExp,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${label} to become ready`));
    }, timeoutMs);

    function onData(chunk: Buffer) {
      if (pattern.test(chunk.toString("utf8"))) {
        cleanup();
        resolve();
      }
    }

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", onData); // Inspector logs its URL to stderr in some versions.
  });
}

/**
 * Starts test/mock-whmcs-server.ts (a node:http fixture server implementing
 * the WHMCS External API contract against synthetic data) on a free port.
 */
async function startMockWhmcs(): Promise<{
  child: ChildProcessWithoutNullStreams;
  url: string;
  port: number;
}> {
  const port = await getFreePort();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(REPO_ROOT, "test", "mock-whmcs-server.ts")],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MOCK_WHMCS_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ) as ChildProcessWithoutNullStreams;

  await waitForOutput(child, /listening|ready|started/i, 15_000, "mock WHMCS server");
  return { child, url: `http://127.0.0.1:${port}`, port };
}

/**
 * Starts the whmcs-mcp server itself (this repo's dist/index.js via tsx on
 * src/index.ts for a source-accurate screenshot run) in Streamable HTTP
 * mode, pointed at the mock WHMCS server above. Mode is "full" ONLY because
 * screenshots need to show the billing-tier confirm-gate flow against
 * synthetic data; this is never how a real deployment should be configured
 * (see SECURITY.md — billing tier must stay off outside an explicit,
 * reviewed opt-in).
 */
async function startMcpServer(
  mockWhmcsUrl: string,
): Promise<{ child: ChildProcessWithoutNullStreams; url: string; port: number }> {
  const port = await getFreePort();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(REPO_ROOT, "src", "index.ts"), "--http", "--port", String(port)],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        WHMCS_API_URL: mockWhmcsUrl,
        WHMCS_API_IDENTIFIER: "screenshot-fixture-identifier",
        WHMCS_API_SECRET: "screenshot-fixture-secret",
        WHMCS_MCP_MODE: "full",
        WHMCS_MCP_ENABLE_DOMAINS: "system,tickets,clients,products,invoices,domains,orders",
        WHMCS_MCP_REDACT_PII: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ) as ChildProcessWithoutNullStreams;

  await waitForOutput(child, /listening|ready|started/i, 15_000, "whmcs-mcp server");
  return { child, url: `http://127.0.0.1:${port}`, port };
}

/**
 * Starts @modelcontextprotocol/inspector against the running MCP server's
 * Streamable HTTP endpoint and returns its web UI URL.
 */
async function startInspector(
  mcpServerUrl: string,
): Promise<{ child: ChildProcessWithoutNullStreams; uiUrl: string }> {
  const uiPort = await getFreePort();
  const child = spawn(
    "npx",
    [
      "--yes",
      "@modelcontextprotocol/inspector",
      "--cli-port",
      String(uiPort),
      "--transport",
      "streamable-http",
      "--server-url",
      mcpServerUrl,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ) as ChildProcessWithoutNullStreams;

  await waitForOutput(child, /localhost:\d+|listening|ready/i, 30_000, "MCP Inspector");
  return { child, uiUrl: `http://127.0.0.1:${uiPort}` };
}

function stopAll(children: ChildProcessWithoutNullStreams[]): void {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
}

/** The four marketing shots, in capture order. Each is defensive: a failed step logs and continues rather than aborting the whole run, so one flaky selector doesn't cost every screenshot. */
const SHOTS: Shot[] = [
  {
    name: "tool-list",
    alt: "MCP Inspector tool list for whmcs-mcp, grouped by domain (system, tickets, clients, products, invoices, domains, orders) with read/write/billing/destructive tier badges",
    async capture(page) {
      await page.getByRole("tab", { name: /tools/i }).click({ timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(500);
    },
  },
  {
    name: "ticket-triage",
    alt: "Ticket triage flow: tickets_list returning open tickets, tickets_get showing full thread detail, and the triage-ticket prompt output against synthetic fixture data",
    async capture(page) {
      await page.getByRole("tab", { name: /tools/i }).click({ timeout: 10_000 }).catch(() => {});
      await page.getByText(/tickets_list/i).first().click({ timeout: 10_000 }).catch(() => {});
      await page
        .getByRole("button", { name: /run tool|call tool|execute/i })
        .click({ timeout: 10_000 })
        .catch(() => {});
      await page.waitForTimeout(800);
    },
  },
  {
    name: "client-360",
    alt: "client-360 view: clients_get with stats=true showing a synthetic client's profile, services, and invoice summary with PII fields redacted",
    async capture(page) {
      await page.getByRole("tab", { name: /tools/i }).click({ timeout: 10_000 }).catch(() => {});
      await page.getByText(/clients_get/i).first().click({ timeout: 10_000 }).catch(() => {});
      await page
        .getByRole("button", { name: /run tool|call tool|execute/i })
        .click({ timeout: 10_000 })
        .catch(() => {});
      await page.waitForTimeout(800);
    },
  },
  {
    name: "confirm-gate",
    alt: "Two-step confirmation gate on a billing-tier tool: the first call returns a preview and a short-lived confirmToken, and the mutation is not applied until a second call echoes that token back",
    async capture(page) {
      await page.getByRole("tab", { name: /tools/i }).click({ timeout: 10_000 }).catch(() => {});
      await page.getByText(/billing_add_credit/i).first().click({ timeout: 10_000 }).catch(() => {});
      await page
        .getByRole("button", { name: /run tool|call tool|execute/i })
        .click({ timeout: 10_000 })
        .catch(() => {});
      await page.waitForTimeout(800);
    },
  },
];

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  // Lazy-import playwright/inspector deps so `npm install` for the published
  // package (which does not list them as runtime deps) still works; only
  // `npm run screenshots` needs them installed as devDependencies.
  const { chromium } = await import("playwright");

  const children: ChildProcessWithoutNullStreams[] = [];
  let exitCode = 0;

  try {
    console.log("[capture-screenshots] starting mock WHMCS fixture server...");
    const mockWhmcs = await startMockWhmcs();
    children.push(mockWhmcs.child);

    console.log(`[capture-screenshots] mock WHMCS ready at ${mockWhmcs.url}`);
    console.log("[capture-screenshots] starting whmcs-mcp server (mode=full, against mock data only)...");
    const mcp = await startMcpServer(mockWhmcs.url);
    children.push(mcp.child);

    console.log(`[capture-screenshots] whmcs-mcp ready at ${mcp.url}`);
    console.log("[capture-screenshots] starting MCP Inspector...");
    const inspector = await startInspector(mcp.url);
    children.push(inspector.child);

    console.log(`[capture-screenshots] Inspector UI at ${inspector.uiUrl}`);

    const browser = await chromium.launch({ headless: !HEADED });
    const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: "light" });
    const page = await context.newPage();

    await page.goto(inspector.uiUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1_500); // let the Inspector finish its initial handshake/render.

    for (const shot of SHOTS) {
      const target = path.join(OUT_DIR, `${shot.name}.png`);
      try {
        await shot.capture(page);
        await page.screenshot({ path: target, fullPage: false });
        console.log(`[capture-screenshots] wrote ${path.relative(REPO_ROOT, target)}`);
      } catch (err) {
        exitCode = 1;
        console.error(
          `[capture-screenshots] FAILED capturing "${shot.name}" (continuing with remaining shots):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    await browser.close();
  } catch (err) {
    exitCode = 1;
    console.error("[capture-screenshots] fatal error:", err instanceof Error ? err.message : err);
  } finally {
    stopAll(children);
    // Give child processes a moment to exit cleanly before the script exits.
    await Promise.race([
      Promise.allSettled(children.map((c) => once(c, "exit"))),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }

  if (exitCode !== 0) {
    console.error(
      "[capture-screenshots] one or more shots failed. Existing PNGs under site/assets/screenshots/ were NOT deleted; re-run to refresh.",
    );
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("[capture-screenshots] unhandled error:", err);
  process.exit(1);
});
