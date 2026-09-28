#!/usr/bin/env node
/**
 * scripts/gen-docs.ts
 *
 * Walks the in-process tool registry (src/tools/registry.ts) and generates:
 *   - docs/tools.md          human-readable tool reference (name, tier, WHMCS action, params table)
 *   - site/data/tools.json   machine-readable catalog consumed by the GitHub Pages marketing site
 *
 * Both outputs are derived from each tool's zod input schema via `z.toJSONSchema`
 * (zod v4), so the docs can never drift from the schemas that actually validate
 * tool calls at runtime. Run via `npm run gen:docs` (tsx scripts/gen-docs.ts);
 * CI also runs it and diffs the result against the committed docs/site files
 * to catch drift (see .github/workflows/ci.yml).
 *
 * This script imports the compiled tool registry rather than re-implementing
 * schema introspection, so it must run against a built (or tsx-executed) tree
 * that exposes `getAllToolDefinitions()` from src/tools/registry.ts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// NOTE: registry.ts is the single source of truth for tool metadata (name,
// domain, tier, WHMCS action, zod schema, MCP annotations). gen-docs never
// hand-maintains a parallel list of tools -- if a tool isn't registered there,
// it will not appear in either generated artifact.
import { getAllToolDefinitions } from "../src/tools/registry.js";

// getAllToolDefinitions() only returns what has actually been registered via
// defineTool(...) as a module-load side effect -- import every built-in
// domain module here (mirrors src/index.ts) so the generated docs cover the
// full catalog, not whatever happened to be imported first.
import "../src/tools/system.js";
import "../src/tools/tickets.js";
import "../src/tools/clients.js";
import "../src/tools/products.js";
import "../src/tools/invoices.js";
import "../src/tools/domains.js";
import "../src/tools/orders.js";
import type { ToolTier } from "../src/safety/policy.js";

interface RegisteredToolLike {
  name: string;
  domain: string;
  tier: ToolTier | string;
  whmcsAction: string;
  description?: string;
  inputSchema?: z.ZodTypeAny;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");
const DOCS_MD_PATH = join(REPO_ROOT, "docs", "tools.md");
const SITE_JSON_PATH = join(REPO_ROOT, "docs", "data", "tools.json");

const TIER_ORDER: string[] = ["read", "write", "billing", "destructive"];

const TIER_LABEL: Record<string, string> = {
  read: "Read (always available)",
  write: "Write (mode=write or full)",
  billing: "Billing (mode=full only, confirm-gated)",
  destructive: "Destructive (confirm-gated)",
};

function sortTools(tools: RegisteredToolLike[]): RegisteredToolLike[] {
  return [...tools].sort((a, b) => {
    const domainCmp = a.domain.localeCompare(b.domain);
    if (domainCmp !== 0) return domainCmp;
    const tierCmp =
      TIER_ORDER.indexOf(String(a.tier)) - TIER_ORDER.indexOf(String(b.tier));
    if (tierCmp !== 0) return tierCmp;
    return a.name.localeCompare(b.name);
  });
}

function groupByDomain(
  tools: RegisteredToolLike[],
): Map<string, RegisteredToolLike[]> {
  const groups = new Map<string, RegisteredToolLike[]>();
  for (const tool of tools) {
    const bucket = groups.get(tool.domain) ?? [];
    bucket.push(tool);
    groups.set(tool.domain, bucket);
  }
  return groups;
}

/**
 * Converts a zod input schema into a flat parameter table (name, type,
 * required, description) using zod v4's built-in z.toJSONSchema -- no
 * zod-to-json-schema dependency needed (DRTW L2: platform/stdlib-adjacent
 * capability already in the declared dependency, zod itself).
 */
function schemaToParamRows(
  schema: z.ZodTypeAny | undefined,
): Array<{ name: string; type: string; required: boolean; description: string }> {
  if (!schema) return [];

  let jsonSchema: ReturnType<typeof z.toJSONSchema>;
  try {
    jsonSchema = z.toJSONSchema(schema, { target: "draft-7" });
  } catch {
    // Schemas that can't be represented in JSON Schema (rare: z.custom, etc.)
    // fall back to an empty table rather than failing the whole doc build.
    return [];
  }

  const props = (jsonSchema as { properties?: Record<string, any> }).properties;
  if (!props) return [];
  const required = new Set(
    ((jsonSchema as { required?: string[] }).required ?? []) as string[],
  );

  return Object.entries(props).map(([name, def]) => {
    const type = Array.isArray(def.type)
      ? def.type.join(" | ")
      : (def.type ?? def.enum ? "enum" : "any");
    const enumSuffix =
      def.enum && Array.isArray(def.enum)
        ? ` (${def.enum.map((v: unknown) => JSON.stringify(v)).join(", ")})`
        : "";
    return {
      name,
      type: `${type}${enumSuffix}`,
      required: required.has(name),
      description: def.description ?? "",
    };
  });
}

function renderMarkdownTable(
  rows: Array<{ name: string; type: string; required: boolean; description: string }>,
): string {
  if (rows.length === 0) {
    return "_No input parameters._\n";
  }
  const header = "| Param | Type | Required | Description |\n|---|---|---|---|";
  const body = rows
    .map(
      (r) =>
        `| \`${r.name}\` | ${r.type} | ${r.required ? "yes" : "no"} | ${
          r.description || "—"
        } |`,
    )
    .join("\n");
  return `${header}\n${body}\n`;
}

function annotationBadges(tool: RegisteredToolLike): string {
  const badges: string[] = [];
  const a = tool.annotations ?? {};
  if (a.readOnlyHint) badges.push("read-only");
  if (a.destructiveHint) badges.push("destructive");
  if (a.idempotentHint) badges.push("idempotent");
  return badges.length ? ` \`${badges.join("` \`")}\`` : "";
}

function renderToolsMarkdown(tools: RegisteredToolLike[]): string {
  const generatedAt = new Date().toISOString();
  const grouped = groupByDomain(sortTools(tools));
  const domains = [...grouped.keys()].sort();

  const toc = domains
    .map((d) => `- [${d}](#${d.toLowerCase().replace(/[^a-z0-9]+/g, "-")})`)
    .join("\n");

  const sections = domains
    .map((domain) => {
      const domainTools = grouped.get(domain) ?? [];
      const toolBlocks = domainTools
        .map((tool) => {
          const params = schemaToParamRows(tool.inputSchema);
          return [
            `### \`${tool.name}\``,
            "",
            `- **WHMCS action:** \`${tool.whmcsAction}\``,
            `- **Tier:** ${TIER_LABEL[String(tool.tier)] ?? tool.tier}${annotationBadges(
              tool,
            )}`,
            tool.description ? `- **Description:** ${tool.description}` : "",
            "",
            renderMarkdownTable(params),
          ]
            .filter((line) => line !== "")
            .join("\n");
        })
        .join("\n\n");

      return `## ${domain}\n\n${toolBlocks}\n`;
    })
    .join("\n");

  return `# WHMCS MCP — Tool Reference

> Generated by \`scripts/gen-docs.ts\` from the live zod schemas in
> \`src/schemas/\` and the tool registry in \`src/tools/registry.ts\`.
> Do not hand-edit; run \`npm run gen:docs\` after changing a tool or schema.
>
> Generated at: ${generatedAt}
> Total tools: ${tools.length}

## Tiers

Every tool is registered at exactly one tier, and the tier — not the tool
name — decides whether it is advertised to a connected client:

| Tier | Advertised when |
|---|---|
| \`read\` | always |
| \`write\` | \`WHMCS_MCP_MODE=write\` or \`full\` |
| \`billing\` | \`WHMCS_MCP_MODE=full\` only, and requires a confirm-token round trip |
| \`destructive\` | requires a confirm-token round trip regardless of mode |

See \`src/safety/policy.ts\` and \`SECURITY.md\` for the full mode/tier matrix.

## Domains

${toc}

${sections}
`;
}

interface ToolCatalogEntry {
  name: string;
  domain: string;
  tier: string;
  whmcsAction: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  params: Array<{ name: string; type: string; required: boolean; description: string }>;
}

function renderSiteCatalog(tools: RegisteredToolLike[]): {
  generatedAt: string;
  totalTools: number;
  domains: string[];
  tools: ToolCatalogEntry[];
} {
  const sorted = sortTools(tools);
  return {
    generatedAt: new Date().toISOString(),
    totalTools: sorted.length,
    domains: [...new Set(sorted.map((t) => t.domain))].sort(),
    tools: sorted.map((tool) => ({
      name: tool.name,
      domain: tool.domain,
      tier: String(tool.tier),
      whmcsAction: tool.whmcsAction,
      description: tool.description ?? "",
      readOnly: Boolean(tool.annotations?.readOnlyHint),
      destructive: Boolean(tool.annotations?.destructiveHint),
      idempotent: Boolean(tool.annotations?.idempotentHint),
      params: schemaToParamRows(tool.inputSchema),
    })),
  };
}

async function main(): Promise<void> {
  const tools = getAllToolDefinitions() as unknown as RegisteredToolLike[];

  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(
      "gen-docs: getAllToolDefinitions() returned no tools -- refusing to overwrite docs/tools.md and site/data/tools.json with an empty catalog",
    );
  }

  const markdown = renderToolsMarkdown(tools);
  const catalog = renderSiteCatalog(tools);

  await mkdir(dirname(DOCS_MD_PATH), { recursive: true });
  await mkdir(dirname(SITE_JSON_PATH), { recursive: true });

  await writeFile(DOCS_MD_PATH, markdown, "utf8");
  await writeFile(SITE_JSON_PATH, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

  // eslint-disable-next-line no-console
  console.error(
    `gen-docs: wrote ${tools.length} tools -> ${DOCS_MD_PATH} and ${SITE_JSON_PATH}`,
  );
}

main().catch((err) => {
  // stderr only -- stdout is reserved for MCP stdio transport elsewhere in
  // this project, and this script inherits that discipline for consistency.
  // eslint-disable-next-line no-console
  console.error("gen-docs failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
