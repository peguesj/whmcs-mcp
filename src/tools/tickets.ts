/**
 * src/tools/tickets.ts
 *
 * MCP tool registrations for the WHMCS "tickets" domain (support-desk actions).
 *
 * Each tool maps 1:1 to a documented WHMCS External API action
 * (https://developers.whmcs.com/api-reference/) and is registered through the
 * shared `defineTool` helper in `./registry.js`, which applies:
 *   - WHMCS_MCP_MODE / WHMCS_MCP_ENABLE_DOMAINS advertisement filtering
 *   - tier gating (read | write | billing | destructive)
 *   - dryRun short-circuiting for mutating tools (no network call, returns a preview)
 *   - two-step confirmToken flow for `confirm: true` tools
 *   - deep redaction of the WHMCS response before it reaches the model
 *
 * This file owns every `toolList` entry from the architecture plan whose
 * `domain` is "tickets". Input schemas live in `../schemas/tickets.js` and are
 * mirrored from WHMCS's documented per-action parameter tables.
 *
 * WHMCS auth/transport note: the WHMCS External API (/includes/api.php) is
 * NOT the same as a generic REST-with-Bearer-token API. Authentication is a
 * form-encoded `identifier` + `secret` pair (optionally `accesskey`) in the
 * POST body, not an Authorization header. `whmcs-client.ts` is the single
 * place that constructs that body; this file never talks to the network
 * directly.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool } from "./registry.js";
import type { WhmcsClient } from "../whmcs-client.js";
import {
  ticketsListSchema,
  ticketsGetSchema,
  ticketsCreateSchema,
  ticketsReplySchema,
  ticketsAddNoteSchema,
  ticketsGetNotesSchema,
  ticketsUpdateSchema,
  ticketsUpdateReplySchema,
  ticketsMergeSchema,
  ticketsDeleteSchema,
  ticketsGetAttachmentSchema,
  ticketsGetCountsSchema,
  ticketsGetDepartmentsSchema,
  ticketsGetStatusesSchema,
  ticketsGetPredefinedRepliesSchema,
} from "../schemas/tickets.js";

/**
 * Registers every tickets_* tool on the given MCP server instance.
 *
 * Called once from src/index.ts after the WhmcsClient and mode/domain
 * filters have been resolved. `defineTool` itself decides whether a given
 * tool is actually advertised (based on tier + WHMCS_MCP_MODE +
 * WHMCS_MCP_ENABLE_DOMAINS), so this function unconditionally attempts to
 * register the full tickets catalog.
 */
export function registerTicketTools(server: McpServer, client: WhmcsClient): void {
  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  defineTool(server, client, {
    name: "tickets_list",
    domain: "tickets",
    tier: "read",
    whmcsAction: "GetTickets",
    schema: ticketsListSchema,
    annotations: {
      title: "List support tickets",
      readOnlyHint: true,
      idempotentHint: true,
    },
    // GetTickets returns { tickets: { ticket: [...] }, numreturned, totalresults, ... }.
    // The client's response normalizer flattens tickets.ticket -> tickets[].
    serialize: (input) => ({
      limitstart: input.limitstart,
      limitnum: input.limitnum,
      deptid: input.deptid,
      clientid: input.clientid,
      email: input.email,
      status: input.status,
      subject: input.subject,
      ignore_dept_assignments: input.ignore_dept_assignments,
    }),
  });

  defineTool(server, client, {
    name: "tickets_get",
    domain: "tickets",
    tier: "read",
    whmcsAction: "GetTicket",
    schema: ticketsGetSchema,
    annotations: {
      title: "Get a single ticket (with replies)",
      readOnlyHint: true,
      idempotentHint: true,
    },
    serialize: (input) => ({
      ticketnum: input.ticketnum,
      ticketid: input.ticketid,
      repliessort: input.repliessort,
    }),
  });

  defineTool(server, client, {
    name: "tickets_get_notes",
    domain: "tickets",
    tier: "read",
    whmcsAction: "GetTicketNotes",
    schema: ticketsGetNotesSchema,
    annotations: {
      title: "Get internal admin notes for a ticket",
      readOnlyHint: true,
      idempotentHint: true,
    },
    serialize: (input) => ({ ticketid: input.ticketid }),
  });

  defineTool(server, client, {
    name: "tickets_get_attachment",
    domain: "tickets",
    tier: "read",
    whmcsAction: "GetTicketAttachment",
    schema: ticketsGetAttachmentSchema,
    annotations: {
      title: "Fetch a ticket/reply/note attachment",
      readOnlyHint: true,
      idempotentHint: true,
    },
    // WHMCS returns { data: { filename, data: <base64> } }. The registry's
    // redaction layer size-caps base64 payloads (WHMCS_MCP_MAX_ATTACHMENT_BYTES)
    // before the result is handed to the model.
    serialize: (input) => ({
      relatedid: input.relatedid,
      type: input.type,
      index: input.index,
    }),
  });

  defineTool(server, client, {
    name: "tickets_get_counts",
    domain: "tickets",
    tier: "read",
    whmcsAction: "GetTicketCounts",
    schema: ticketsGetCountsSchema,
    annotations: {
      title: "Get open/answered/etc. ticket counts",
      readOnlyHint: true,
      idempotentHint: true,
    },
    serialize: (input) => ({
      ignoreDepartmentAssignments: input.ignoreDepartmentAssignments,
      includeCountsByStatus: input.includeCountsByStatus,
    }),
  });

  defineTool(server, client, {
    name: "tickets_get_departments",
    domain: "tickets",
    tier: "read",
    whmcsAction: "GetSupportDepartments",
    schema: ticketsGetDepartmentsSchema,
    annotations: {
      title: "List support departments",
      readOnlyHint: true,
      idempotentHint: true,
    },
    serialize: (input) => ({
      ignore_dept_assignments: input.ignore_dept_assignments,
    }),
  });

  defineTool(server, client, {
    name: "tickets_get_statuses",
    domain: "tickets",
    tier: "read",
    whmcsAction: "GetSupportStatuses",
    schema: ticketsGetStatusesSchema,
    annotations: {
      title: "List support ticket statuses",
      readOnlyHint: true,
      idempotentHint: true,
    },
    serialize: (input) => ({ deptid: input.deptid }),
  });

  defineTool(server, client, {
    name: "tickets_get_predefined_replies",
    domain: "tickets",
    tier: "read",
    whmcsAction: "GetTicketPredefinedReplies",
    schema: ticketsGetPredefinedRepliesSchema,
    annotations: {
      title: "List predefined ticket replies",
      readOnlyHint: true,
      idempotentHint: true,
    },
    serialize: (input) => ({ catid: input.catid }),
  });

  // ---------------------------------------------------------------------
  // Writes (tier: write) — advertised in WHMCS_MCP_MODE=write|full
  // ---------------------------------------------------------------------

  defineTool(server, client, {
    name: "tickets_create",
    domain: "tickets",
    tier: "write",
    whmcsAction: "OpenTicket",
    schema: ticketsCreateSchema,
    supportsDryRun: true,
    annotations: {
      title: "Open a new support ticket",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    // customfields is documented as a base64-encoded serialized-PHP-array
    // string in the External API; the schema layer owns building that value
    // so this file only forwards it verbatim.
    serialize: (input) => ({
      deptid: input.deptid,
      subject: input.subject,
      message: input.message,
      clientid: input.clientid,
      contactid: input.contactid,
      name: input.name,
      email: input.email,
      priority: input.priority,
      serviceid: input.serviceid,
      domainid: input.domainid,
      admin: input.admin,
      markdown: input.markdown,
      customfields: input.customfields,
    }),
  });

  defineTool(server, client, {
    name: "tickets_reply",
    domain: "tickets",
    tier: "write",
    whmcsAction: "AddTicketReply",
    schema: ticketsReplySchema,
    supportsDryRun: true,
    annotations: {
      title: "Reply to a support ticket",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    serialize: (input) => ({
      ticketid: input.ticketid,
      message: input.message,
      adminusername: input.adminusername,
      clientid: input.clientid,
      contactid: input.contactid,
      status: input.status,
      markdown: input.markdown,
      noemail: input.noemail,
      created: input.created,
    }),
  });

  defineTool(server, client, {
    name: "tickets_add_note",
    domain: "tickets",
    tier: "write",
    whmcsAction: "AddTicketNote",
    schema: ticketsAddNoteSchema,
    supportsDryRun: true,
    annotations: {
      title: "Add an internal note to a ticket",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    serialize: (input) => ({
      ticketid: input.ticketid,
      ticketnum: input.ticketnum,
      message: input.message,
      markdown: input.markdown,
    }),
  });

  defineTool(server, client, {
    name: "tickets_update",
    domain: "tickets",
    tier: "write",
    whmcsAction: "UpdateTicket",
    schema: ticketsUpdateSchema,
    supportsDryRun: true,
    annotations: {
      title: "Update ticket metadata (status/department/priority/flag)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    serialize: (input) => ({
      ticketid: input.ticketid,
      status: input.status,
      deptid: input.deptid,
      subject: input.subject,
      priority: input.priority,
      flag: input.flag,
      userid: input.userid,
      email: input.email,
      cc: input.cc,
      removeFlag: input.removeFlag,
    }),
  });

  defineTool(server, client, {
    name: "tickets_update_reply",
    domain: "tickets",
    tier: "write",
    whmcsAction: "UpdateTicketReply",
    schema: ticketsUpdateReplySchema,
    supportsDryRun: true,
    annotations: {
      title: "Edit an existing ticket reply",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    serialize: (input) => ({
      replyid: input.replyid,
      message: input.message,
      markdown: input.markdown,
    }),
  });

  // ---------------------------------------------------------------------
  // Destructive (tier: destructive) — always confirm-gated, regardless of mode
  // ---------------------------------------------------------------------

  defineTool(server, client, {
    name: "tickets_merge",
    domain: "tickets",
    tier: "destructive",
    whmcsAction: "MergeTicket",
    schema: ticketsMergeSchema,
    requiresConfirm: true,
    annotations: {
      title: "Merge one or more tickets into a target ticket",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    // First call (no confirmToken): registry short-circuits before this
    // serializer runs and returns a preview + confirmToken instead.
    serialize: (input) => ({
      ticketid: input.ticketid,
      mergeticketids: input.mergeticketids,
      newsubject: input.newsubject,
    }),
    describePreview: (input) =>
      `Merge ticket(s) [${input.mergeticketids}] into ticket #${input.ticketid}` +
      (input.newsubject ? ` with new subject "${input.newsubject}"` : "") +
      `. This cannot be undone.`,
  });

  defineTool(server, client, {
    name: "tickets_delete",
    domain: "tickets",
    tier: "destructive",
    whmcsAction: "DeleteTicket",
    schema: ticketsDeleteSchema,
    requiresConfirm: true,
    annotations: {
      title: "Permanently delete a ticket",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    serialize: (input) => ({ ticketid: input.ticketid }),
    describePreview: (input) =>
      `Permanently delete ticket #${input.ticketid}, including all replies and notes. This cannot be undone.`,
  });
}
