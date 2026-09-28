/**
 * src/prompts.ts
 *
 * MCP prompt registrations for whmcs-mcp.
 *
 * Prompts are reusable, user-invocable message templates that steer the
 * assistant through a specific WHMCS workflow by naming which tools to call
 * and in what order, without themselves touching the network. Per the MCP
 * spec, prompt *arguments* are always strings (clients render them as plain
 * text fields), so every schema below is a ZodRawShape of `z.string()` /
 * `z.string().optional()` — any numeric coercion (e.g. a ticket ID) happens
 * inside the tool call the resulting message asks the model to make, not
 * here.
 *
 * This file owns the three prompts from the architecture plan:
 *   - triage-ticket:          intake + recommended-response drafting for one
 *                             support ticket (tickets_get, tickets_get_notes,
 *                             tickets_get_departments/statuses).
 *   - client-360:             a single consolidated view of one client across
 *                             clients_get, clients_get_services,
 *                             clients_get_addons, domains_list, and
 *                             billing_list_invoices.
 *   - overdue-invoice-review: a billing-hygiene sweep across overdue
 *                             invoices (billing_list_invoices +
 *                             billing_get_invoice), explicitly read-only and
 *                             scoped to *review*, never mutation — WHMCS
 *                             invoice writes stay operator-manual per policy
 *                             (see SECURITY.md).
 *
 * Each prompt returns a single user-role message: a structured instruction
 * naming the exact tool names to call, the order to call them in, and what
 * the final answer should contain. It intentionally does not call any tool
 * itself — MCP prompts hand back *messages*, and the connected client/model
 * is the one that invokes tools per the wire protocol.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Registers every prompt on the given MCP server instance.
 *
 * Called once from src/index.ts, after tool and resource registration.
 * Prompts are not tier-gated the way tools are: they only ever *suggest*
 * tool calls, and the tools they name remain subject to the normal
 * WHMCS_MCP_MODE / WHMCS_MCP_ENABLE_DOMAINS / tier gating in
 * src/safety/policy.ts and src/tools/registry.ts at call time. A prompt
 * naming a billing-tier tool (e.g. overdue-invoice-review naming
 * billing_get_invoice, which is a read and always available) will simply
 * have that suggestion go unfulfilled if the underlying tool isn't
 * advertised in the connected server's current mode.
 */
export function registerPrompts(server: McpServer): void {
  registerTriageTicketPrompt(server);
  registerClient360Prompt(server);
  registerOverdueInvoiceReviewPrompt(server);
}

// ---------------------------------------------------------------------------
// triage-ticket
// ---------------------------------------------------------------------------

const triageTicketArgs = {
  ticketId: z
    .string()
    .optional()
    .describe(
      "Numeric WHMCS ticket ID (tickets_get's `ticketid`). Provide this or ticketNumber.",
    ),
  ticketNumber: z
    .string()
    .optional()
    .describe(
      "WHMCS-format ticket number, e.g. '123456' or 'ABC-123456' (tickets_get's `ticketnum`). Provide this or ticketId.",
    ),
  focus: z
    .string()
    .optional()
    .describe(
      "Optional steer for the triage, e.g. 'billing dispute', 'possible SLA breach', 'needs escalation to engineering'.",
    ),
};

function registerTriageTicketPrompt(server: McpServer): void {
  server.registerPrompt(
    "triage-ticket",
    {
      title: "Triage a WHMCS support ticket",
      description:
        "Pull one ticket's full thread and department/status context, then produce a triage summary: priority read, whether it needs a status/department change, and a drafted next reply. Read-only.",
      argsSchema: triageTicketArgs,
    },
    (args) => {
      const { ticketId, ticketNumber, focus } = args as {
        ticketId?: string;
        ticketNumber?: string;
        focus?: string;
      };

      if (!ticketId && !ticketNumber) {
        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text:
                  "I want to triage a WHMCS support ticket but no ticketId or ticketNumber " +
                  "was provided. Ask the operator which ticket to triage before calling any tools.",
              },
            },
          ],
        };
      }

      const identifierLine = ticketId
        ? `ticketid: ${ticketId}`
        : `ticketnum: ${ticketNumber}`;
      const focusLine = focus ? `\n\nFocus area requested: ${focus}` : "";

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "Triage this WHMCS support ticket. This is a read-only investigation —",
                "do not call any write-tier or higher tool in this pass.",
                "",
                `Ticket identifier — ${identifierLine}`,
                focusLine,
                "",
                "Steps:",
                "1. Call `tickets_get` with the identifier above (use `repliessort: \"ASC\"` so the",
                "   thread reads chronologically). If it fails with a not-found error, stop and",
                "   report that back instead of guessing at another identifier.",
                "2. Call `tickets_get_notes` for the same ticket to pick up any internal-only",
                "   context the client never saw.",
                "3. Call `tickets_get_departments` and `tickets_get_statuses` once, to have the",
                "   full set of valid values on hand for the recommendation in step 4.",
                "4. Produce a triage report with these sections:",
                "   - **Summary** — one or two sentences on what the client is asking for.",
                "   - **Priority read** — your assessed priority/urgency and why, independent of",
                "     whatever priority is currently set.",
                "   - **Status/Department recommendation** — whether the current status or",
                "     department looks wrong given the thread, and what `tickets_update` args",
                "     (deptid/status/priority) would need to be if the operator later approves it.",
                "     Do NOT call `tickets_update` yourself.",
                "   - **Drafted reply** — a client-ready reply the operator can send as-is or",
                "     edit, matching the tone of prior agent replies in the thread. Present it as",
                "     the exact `message` argument for `tickets_reply`, but do not call that tool.",
                "   - **Escalation flag** — explicitly say YES/NO on whether this needs a human",
                "     escalation before any reply goes out (e.g. billing dispute, legal threat,",
                "     security report, angry VIP client), and why.",
              ]
                .filter(Boolean)
                .join("\n"),
            },
          },
        ],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// client-360
// ---------------------------------------------------------------------------

const client360Args = {
  clientId: z
    .string()
    .optional()
    .describe(
      "Numeric WHMCS client ID (clients_get's `clientid`). Provide this or email.",
    ),
  email: z
    .string()
    .optional()
    .describe(
      "Client's email address (clients_get's `email`). Provide this or clientId.",
    ),
};

function registerClient360Prompt(server: McpServer): void {
  server.registerPrompt(
    "client-360",
    {
      title: "360-degree view of a WHMCS client",
      description:
        "Consolidate one client's profile, active services/addons, domains, and invoice history into a single account-health summary. Read-only.",
      argsSchema: client360Args,
    },
    (args) => {
      const { clientId, email } = args as { clientId?: string; email?: string };

      if (!clientId && !email) {
        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text:
                  "I want a client-360 view but no clientId or email was provided. Ask the " +
                  "operator which client before calling any tools.",
              },
            },
          ],
        };
      }

      const identifierLine = clientId ? `clientid: ${clientId}` : `email: ${email}`;

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "Build a 360-degree account view for this WHMCS client. This is a read-only",
                "investigation across several domains — call every tool below even if an early",
                "one already answers part of the question, so the report is complete.",
                "",
                `Client identifier — ${identifierLine}`,
                "",
                "Steps:",
                "1. Call `clients_get` with `stats: true` to get the profile plus lifetime",
                "   stats. If `clientId` wasn't given, use the `clientid` this call returns for",
                "   every subsequent step. Remember: PII in the response may already be redacted",
                "   per WHMCS_MCP_REDACT_PII — do not attempt to reconstruct redacted fields.",
                "2. Call `clients_get_services` for that clientid to list active/inactive",
                "   hosting/product services, and `clients_get_addons` for the same clientid to",
                "   list product addons.",
                "3. Call `domains_list` for that clientid to list registered domains and their",
                "   expiry/renewal state.",
                "4. Call `billing_list_invoices` for that clientid (no status filter, so both",
                "   paid and unpaid show up) to get the invoice history; if there are more than",
                "   `limitnum` results, note that the list was truncated rather than silently",
                "   dropping rows.",
                "5. Call `billing_get_credits` for that clientid to surface any account credit",
                "   balance.",
                "6. Produce a report with these sections:",
                "   - **Profile** — name/company/status/group, redacted-safe contact summary.",
                "   - **Services & addons** — each service's product, status, next due date,",
                "     billing cycle; flag anything Suspended/Terminated/Cancelled.",
                "   - **Domains** — each domain's status and days-to-expiry; flag anything",
                "     expiring within 30 days or already expired.",
                "   - **Billing health** — total unpaid balance, count of overdue invoices,",
                "     current credit balance, and any pattern worth flagging (e.g. repeated",
                "     late payment, a recent large refund/credit).",
                "   - **Overall account-health read** — one paragraph: healthy / at-risk /",
                "     needs-attention, and the single most important next action if any.",
              ]
                .filter(Boolean)
                .join("\n"),
            },
          },
        ],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// overdue-invoice-review
// ---------------------------------------------------------------------------

const overdueInvoiceReviewArgs = {
  clientId: z
    .string()
    .optional()
    .describe(
      "Optional WHMCS clientid to scope the review to one client's invoices. Omit to review across all clients (subject to limitnum paging).",
    ),
  minDaysOverdue: z
    .string()
    .optional()
    .describe(
      "Optional minimum number of days past due date to include, as a string integer, e.g. '30'. Omit for no minimum.",
    ),
};

function registerOverdueInvoiceReviewPrompt(server: McpServer): void {
  server.registerPrompt(
    "overdue-invoice-review",
    {
      title: "Review overdue WHMCS invoices",
      description:
        "Surface overdue invoices, summarize exposure and aging, and flag which accounts need operator attention. Strictly read-only review — never drafts or calls any invoice-mutating tool, since invoice writes are operator-manual by standing policy.",
      argsSchema: overdueInvoiceReviewArgs,
    },
    (args) => {
      const { clientId, minDaysOverdue } = args as {
        clientId?: string;
        minDaysOverdue?: string;
      };

      const scopeLine = clientId
        ? `Scope: clientid ${clientId} only.`
        : "Scope: all clients (respect pagination — do not assume the first page is everything).";
      const thresholdLine = minDaysOverdue
        ? `Only include invoices at least ${minDaysOverdue} day(s) past their due date.`
        : "Include every invoice WHMCS currently reports with status Overdue.";

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "Review overdue invoices in WHMCS. This is a READ-ONLY review.",
                "",
                "IMPORTANT — standing operator policy: invoices are operator-manual. Do not call",
                "`billing_create_invoice`, `billing_update_invoice`, `billing_add_payment`,",
                "`billing_apply_credit`, `billing_capture_payment`, or any other invoice-mutating",
                "tool during this review, even if it is technically available in the current",
                "server mode. Your job is to identify and summarize, never to act.",
                "",
                scopeLine,
                thresholdLine,
                "",
                "Steps:",
                "1. Call `billing_list_invoices` with `status: \"Overdue\"`" +
                  (clientId ? ` and \`userid: ${clientId}\`` : "") +
                  ". If the result looks paginated (a full page at `limitnum`), call it again",
                "   with an advanced `limitstart` until you have every overdue invoice in scope,",
                "   and say in the final report how many pages you walked.",
                "2. For each overdue invoice returned, call `billing_get_invoice` with its",
                "   `invoiceid` to get line items, prior transactions, and the exact outstanding",
                "   balance (do not assume the list view's total equals the balance still owed).",
                "3. If `minDaysOverdue` was given, drop any invoice whose due date is more",
                "   recent than that threshold from the report (but mention how many were",
                "   excluded this way).",
                "4. Produce a report with these sections:",
                "   - **Totals** — invoice count and total outstanding balance in scope.",
                "   - **Aging breakdown** — bucket the invoices (e.g. 1-30 / 31-60 / 61-90 /",
                "     90+ days overdue) with count and $ total per bucket.",
                "   - **Top exposure** — the 5 largest outstanding balances, each with",
                "     invoiceid, clientid, amount owed, and days overdue.",
                "   - **Repeat offenders** — any client appearing on more than one overdue",
                "     invoice in this scope.",
                "   - **Recommended next actions** — phrased for the operator to execute by",
                "     hand (e.g. 'send a reminder for invoice #123', 'consider a payment plan',",
                "     'client 456 has 3 consecutive overdue invoices — review before renewal').",
                "     Never phrase these as something you will do yourself.",
              ]
                .filter(Boolean)
                .join("\n"),
            },
          },
        ],
      };
    },
  );
}
