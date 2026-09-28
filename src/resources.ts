/**
 * src/resources.ts
 *
 * MCP resource registrations for the WHMCS MCP server:
 *
 *   - whmcs://system/version           -> WhmcsDetails
 *   - whmcs://support/departments      -> GetSupportDepartments
 *   - whmcs://support/statuses         -> GetSupportStatuses
 *   - whmcs://billing/payment-methods  -> GetPaymentMethods
 *   - whmcs://orders/statuses          -> GetOrderStatuses
 *
 * These are all cheap, low-cardinality, read-only WHMCS External API lookups
 * that are useful as ambient context for a client (department ids for
 * `tickets_create`, valid ticket/order status strings for filtering,
 * configured payment gateways) without spending a tool call, and without any
 * mode/domain gating: resources are exposed regardless of WHMCS_MCP_MODE
 * (unlike tools, MCP resources have no annotations analogous to
 * readOnlyHint/destructiveHint for the client to reason about safety with,
 * but every action registered here is itself a WHMCS action of tier "read"
 * in the architecture plan's toolList, so there is nothing to gate).
 *
 * Every resource goes through the same `whmcs.call()` boundary tools use
 * (src/whmcs-client.ts) and the same deep redaction (src/safety/redact.ts)
 * before its JSON text reaches the client — a resource read is not a lower
 * trust path than a tool call.
 *
 * WHMCS response-shape note: the WHMCS External API's documented JSON
 * envelope typically nests a repeating collection under a plural wrapper key
 * matching the action's subject, e.g. `{ departments: { department: [...] } }`
 * for GetSupportDepartments (developers.whmcs.com/api-reference). Some WHMCS
 * versions/actions have been observed to omit the outer plural wrapper and
 * return the singular collection key directly at the response root instead
 * (`{ department: [...] }`), and `../src/types/whmcs.ts` in this repo models
 * the latter, flatter shape. Rather than pick one and silently drop rows on
 * the other, `firstNonEmptyCollection()` below tries every plausible
 * (container, itemKey) path for each action and returns the first match —
 * this is defense-in-depth against that ambiguity, not a substitute for
 * verifying the exact shape at runtime via `system_get_details`
 * (WhmcsDetails) followed by one live GetSupportDepartments/etc. call
 * against the connected instance's actual version. If a future audit
 * confirms exactly one shape for the target WHMCS version, the candidate
 * list for that resource can be trimmed to a single entry.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ReadResourceCallback,
  ResourceMetadata,
} from "@modelcontextprotocol/sdk/server/mcp.js";

import { type WhmcsClient, unwrapCollection, WhmcsApiError } from "./whmcs-client.js";
import type { WhmcsMcpConfig } from "./config.js";
import { redactUnknown, redactError, type RedactOptions } from "./safety/redact.js";
import { logger } from "./logger.js";
import type {
  WhmcsDetails,
  WhmcsSupportDepartment,
  WhmcsSupportStatus,
  WhmcsPaymentMethod,
  WhmcsOrderStatusRaw,
} from "./types/whmcs.js";

const log = logger.child({ component: "resources" });

// ---------------------------------------------------------------------------
// Shape-tolerant collection extraction (see file header note above)
// ---------------------------------------------------------------------------

/** One place to look for a WHMCS action's repeating collection. */
interface CollectionCandidate {
  /** Path (dot-separated) from the raw response root to the container object holding `itemKey`. Empty string = the root itself. */
  containerPath: string;
  /** The singular key WHMCS nests the row(s) under, per `unwrapCollection`'s contract. */
  itemKey: string;
}

function resolvePath(root: unknown, path: string): unknown {
  if (path === "") return root;
  let cur: unknown = root;
  for (const segment of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

/**
 * Tries each candidate (container path + item key) in order against the raw
 * WHMCS response and returns the first one that yields at least one row.
 * Returns an empty array (not undefined) when every candidate is empty or
 * absent, which is a legitimate result for e.g. a WHMCS instance with zero
 * support departments configured.
 */
function firstNonEmptyCollection<T>(
  raw: unknown,
  candidates: readonly CollectionCandidate[],
): T[] {
  for (const { containerPath, itemKey } of candidates) {
    const container = resolvePath(raw, containerPath);
    const rows = unwrapCollection<T>(container, itemKey);
    if (rows.length > 0) return rows;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Shared read-callback wrapper: call -> redact -> JSON text, never throw
// ---------------------------------------------------------------------------

function jsonReadCallback(
  resourceName: string,
  whmcsAction: string,
  client: WhmcsClient,
  redactOptions: RedactOptions,
  shape: (raw: Record<string, unknown>) => unknown,
): ReadResourceCallback {
  return async (uri) => {
    try {
      const raw = await client.call<Record<string, unknown>>(whmcsAction);
      const shaped = shape(raw);
      const redacted = redactUnknown(shaped, redactOptions);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(redacted, null, 2),
          },
        ],
      };
    } catch (err) {
      const safe = redactError(err, redactOptions);
      log.error(`resource read failed: ${resourceName}`, {
        whmcsAction,
        error: safe.message,
        httpStatus: err instanceof WhmcsApiError ? err.httpStatus : undefined,
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              { error: safe.message, resource: resourceName, whmcsAction },
              null,
              2,
            ),
          },
        ],
      };
    }
  };
}

// ---------------------------------------------------------------------------
// registerResources
// ---------------------------------------------------------------------------

/**
 * Registers every whmcs://* resource on the given MCP server instance.
 * Called once from src/index.ts after the WhmcsClient and config have been
 * constructed. Resource reads are not gated by WHMCS_MCP_MODE or
 * WHMCS_MCP_ENABLE_DOMAINS — every action backing a resource here is a
 * tier "read" WHMCS External API call with no side effects.
 */
export function registerResources(
  server: McpServer,
  client: WhmcsClient,
  config: WhmcsMcpConfig,
): void {
  const redactOptions: RedactOptions = { redactPii: config.redactPii };

  // -------------------------------------------------------------------
  // whmcs://system/version -> WhmcsDetails
  // -------------------------------------------------------------------
  server.registerResource(
    "whmcs-system-version",
    "whmcs://system/version",
    {
      title: "WHMCS system version",
      description:
        "Connected WHMCS instance's version/release info (WhmcsDetails). Use this for " +
        "runtime version-compatibility checks (see docs/version-compatibility.md); a " +
        "warning is logged at startup if the reported version is below 8.0.",
      mimeType: "application/json",
    } satisfies ResourceMetadata,
    jsonReadCallback(
      "whmcs-system-version",
      "WhmcsDetails",
      client,
      redactOptions,
      (raw) => {
        const details = raw as unknown as WhmcsDetails;
        return {
          version: details.whmcs.version,
          releaseStatus: details.whmcs.release_status,
          edition: details.whmcs.edition ?? null,
        };
      },
    ),
  );

  // -------------------------------------------------------------------
  // whmcs://support/departments -> GetSupportDepartments
  // -------------------------------------------------------------------
  server.registerResource(
    "whmcs-support-departments",
    "whmcs://support/departments",
    {
      title: "WHMCS support departments",
      description:
        "Support ticket departments configured on the connected WHMCS instance " +
        "(GetSupportDepartments). Use a returned `id` as `deptid` when calling " +
        "tickets_create or filtering tickets_list.",
      mimeType: "application/json",
    } satisfies ResourceMetadata,
    jsonReadCallback(
      "whmcs-support-departments",
      "GetSupportDepartments",
      client,
      redactOptions,
      (raw) => ({
        departments: firstNonEmptyCollection<WhmcsSupportDepartment>(raw, [
          // Documented shape: { departments: { department: [...] } }
          { containerPath: "departments", itemKey: "department" },
          // Flat shape some responses/versions have been observed to use.
          { containerPath: "", itemKey: "department" },
        ]),
      }),
    ),
  );

  // -------------------------------------------------------------------
  // whmcs://support/statuses -> GetSupportStatuses
  // -------------------------------------------------------------------
  server.registerResource(
    "whmcs-support-statuses",
    "whmcs://support/statuses",
    {
      title: "WHMCS support ticket statuses",
      description:
        "Valid support ticket status strings (GetSupportStatuses), e.g. \"Open\", " +
        "\"Answered\", \"Customer-Reply\", \"Closed\". Use a returned `title` verbatim as " +
        "the `status` filter for tickets_list or the `status` field on tickets_update.",
      mimeType: "application/json",
    } satisfies ResourceMetadata,
    jsonReadCallback(
      "whmcs-support-statuses",
      "GetSupportStatuses",
      client,
      redactOptions,
      (raw) => ({
        statuses: firstNonEmptyCollection<WhmcsSupportStatus>(raw, [
          // Documented shape: { statuses: { status: [...] } }
          { containerPath: "statuses", itemKey: "status" },
          // Flat shape modeled by src/types/whmcs.ts's WhmcsSupportStatusesRaw.
          { containerPath: "", itemKey: "status" },
        ]),
      }),
    ),
  );

  // -------------------------------------------------------------------
  // whmcs://billing/payment-methods -> GetPaymentMethods
  // -------------------------------------------------------------------
  server.registerResource(
    "whmcs-billing-payment-methods",
    "whmcs://billing/payment-methods",
    {
      title: "WHMCS configured payment methods",
      description:
        "Payment gateway modules enabled on the connected WHMCS instance " +
        "(GetPaymentMethods) — module name + display name only, never gateway " +
        "credentials or a client's stored payment instrument data (see " +
        "clients_get_services / billing_get_pay_methods for that, which are card- " +
        "masked separately). Use a returned `module` as `paymentmethod` on order/" +
        "invoice tools.",
      mimeType: "application/json",
    } satisfies ResourceMetadata,
    jsonReadCallback(
      "whmcs-billing-payment-methods",
      "GetPaymentMethods",
      client,
      redactOptions,
      (raw) => ({
        paymentMethods: firstNonEmptyCollection<WhmcsPaymentMethod>(raw, [
          // Documented shape: { paymentmethods: { paymentmethod: [...] } }
          { containerPath: "paymentmethods", itemKey: "paymentmethod" },
          // Flat shape modeled by src/types/whmcs.ts's WhmcsPaymentMethodsRaw.
          { containerPath: "", itemKey: "paymentmethod" },
        ]),
      }),
    ),
  );

  // -------------------------------------------------------------------
  // whmcs://orders/statuses -> GetOrderStatuses
  // -------------------------------------------------------------------
  server.registerResource(
    "whmcs-orders-statuses",
    "whmcs://orders/statuses",
    {
      title: "WHMCS order statuses",
      description:
        "Valid order status strings (GetOrderStatuses), e.g. \"Pending\", \"Active\", " +
        "\"Fraud\", \"Cancelled\". Use a returned `name` verbatim as the `status` filter " +
        "for orders_list.",
      mimeType: "application/json",
    } satisfies ResourceMetadata,
    jsonReadCallback(
      "whmcs-orders-statuses",
      "GetOrderStatuses",
      client,
      redactOptions,
      (raw) => ({
        statuses: firstNonEmptyCollection<WhmcsOrderStatusRaw>(raw, [
          // Documented shape: { orderstatuses: { status: [...] } }
          { containerPath: "orderstatuses", itemKey: "status" },
          // Flat shape modeled by src/types/whmcs.ts's WhmcsGetOrderStatusesRaw.
          { containerPath: "", itemKey: "status" },
        ]),
      }),
    ),
  );

  log.info("registered 5 whmcs:// resources", {
    resources: [
      "whmcs://system/version",
      "whmcs://support/departments",
      "whmcs://support/statuses",
      "whmcs://billing/payment-methods",
      "whmcs://orders/statuses",
    ],
  });
}
