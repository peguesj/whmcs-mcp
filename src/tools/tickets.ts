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
 *   - two-step confirmToken flow for destructive tools
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

import { defineTool, type ToolContext, type ToolHandlerResult } from "./registry.js";
import {
  ticketsListInputSchema,
  ticketsGetInputSchema,
  ticketsCreateInputSchema,
  ticketsReplyInputSchema,
  ticketsAddNoteInputSchema,
  ticketsGetNotesInputSchema,
  ticketsUpdateInputSchema,
  ticketsUpdateReplyInputSchema,
  ticketsMergeInputSchema,
  ticketsDeleteInputSchema,
  ticketsGetAttachmentInputSchema,
  ticketsGetCountsInputSchema,
  ticketsGetDepartmentsInputSchema,
  ticketsGetStatusesInputSchema,
  ticketsGetPredefinedRepliesInputSchema,
} from "../schemas/tickets.js";
import { unwrapCollection } from "../whmcs-client.js";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

defineTool({
  name: "tickets_list",
  domain: "tickets",
  tier: "read",
  whmcsAction: "GetTickets",
  description: "List support tickets, filterable by department, client, email, status, or subject.",
  inputSchema: ticketsListInputSchema,
  annotations: { title: "List support tickets", readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    // GetTickets returns { tickets: { ticket: [...] }, numreturned, totalresults, ... }.
    // Flatten tickets.ticket -> tickets[] so every caller gets a plain array.
    const res = await ctx.whmcs.call<{ tickets?: unknown }>("GetTickets", {
      limitstart: input.limitstart,
      limitnum: input.limitnum,
      deptid: input.deptid,
      clientid: input.clientid,
      email: input.email,
      status: input.status,
      subject: input.subject,
      ignore_dept_assignments: input.ignore_dept_assignments,
    });
    const tickets = unwrapCollection(res.tickets, "ticket");
    return { data: { ...res, tickets } };
  },
});

defineTool({
  name: "tickets_get",
  domain: "tickets",
  tier: "read",
  whmcsAction: "GetTicket",
  description: "Get a single ticket, including its replies, by ticketid or ticketnum.",
  inputSchema: ticketsGetInputSchema,
  annotations: { title: "Get a single ticket (with replies)", readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("GetTicket", {
      ticketnum: input.ticketnum,
      ticketid: input.ticketid,
      repliessort: input.repliessort,
    });
    return { data: res };
  },
});

defineTool({
  name: "tickets_get_notes",
  domain: "tickets",
  tier: "read",
  whmcsAction: "GetTicketNotes",
  description: "Get internal admin notes for a ticket.",
  inputSchema: ticketsGetNotesInputSchema,
  annotations: { title: "Get internal admin notes for a ticket", readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("GetTicketNotes", { ticketid: input.ticketid });
    return { data: res };
  },
});

defineTool({
  name: "tickets_get_attachment",
  domain: "tickets",
  tier: "read",
  whmcsAction: "GetTicketAttachment",
  description: "Fetch a ticket, reply, or note attachment.",
  inputSchema: ticketsGetAttachmentInputSchema,
  annotations: { title: "Fetch a ticket/reply/note attachment", readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    // WHMCS returns { data: { filename, data: <base64> } }. The registry's
    // redaction layer size-caps base64 payloads (WHMCS_MCP_MAX_ATTACHMENT_BYTES)
    // before the result is handed to the model.
    const res = await ctx.whmcs.call("GetTicketAttachment", {
      relatedid: input.relatedid,
      type: input.type,
      index: input.index,
    });
    return { data: res };
  },
});

defineTool({
  name: "tickets_get_counts",
  domain: "tickets",
  tier: "read",
  whmcsAction: "GetTicketCounts",
  description: "Get open/answered/etc. ticket counts.",
  inputSchema: ticketsGetCountsInputSchema,
  annotations: { title: "Get open/answered/etc. ticket counts", readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("GetTicketCounts", {
      ignoreDepartmentAssignments: input.ignoreDepartmentAssignments,
      includeCountsByStatus: input.includeCountsByStatus,
    });
    return { data: res };
  },
});

defineTool({
  name: "tickets_get_departments",
  domain: "tickets",
  tier: "read",
  whmcsAction: "GetSupportDepartments",
  description: "List support departments.",
  inputSchema: ticketsGetDepartmentsInputSchema,
  annotations: { title: "List support departments", readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("GetSupportDepartments", {
      ignore_dept_assignments: input.ignore_dept_assignments,
    });
    return { data: res };
  },
});

defineTool({
  name: "tickets_get_statuses",
  domain: "tickets",
  tier: "read",
  whmcsAction: "GetSupportStatuses",
  description: "List support ticket statuses.",
  inputSchema: ticketsGetStatusesInputSchema,
  annotations: { title: "List support ticket statuses", readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("GetSupportStatuses", { deptid: input.deptid });
    return { data: res };
  },
});

defineTool({
  name: "tickets_get_predefined_replies",
  domain: "tickets",
  tier: "read",
  whmcsAction: "GetTicketPredefinedReplies",
  description: "List predefined ticket replies.",
  inputSchema: ticketsGetPredefinedRepliesInputSchema,
  annotations: { title: "List predefined ticket replies", readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("GetTicketPredefinedReplies", { catid: input.catid });
    return { data: res };
  },
});

// ---------------------------------------------------------------------------
// Writes (tier: write) — advertised in WHMCS_MCP_MODE=write|full
// ---------------------------------------------------------------------------

defineTool({
  name: "tickets_create",
  domain: "tickets",
  tier: "write",
  whmcsAction: "OpenTicket",
  description: "Open a new support ticket.",
  inputSchema: ticketsCreateInputSchema,
  annotations: { title: "Open a new support ticket", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    // customfields is documented as a base64-encoded serialized-PHP-array
    // string in the External API; the schema layer owns building that value
    // so this file only forwards it verbatim.
    const res = await ctx.whmcs.call("OpenTicket", {
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
      customfields: input.customfields
        ? Buffer.from(JSON.stringify(input.customfields), "utf-8").toString("base64")
        : undefined,
    });
    return { data: res, summary: `Ticket opened: "${input.subject}".` };
  },
});

defineTool({
  name: "tickets_reply",
  domain: "tickets",
  tier: "write",
  whmcsAction: "AddTicketReply",
  description: "Reply to a support ticket.",
  inputSchema: ticketsReplyInputSchema,
  annotations: { title: "Reply to a support ticket", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("AddTicketReply", {
      ticketid: input.ticketid,
      message: input.message,
      adminusername: input.adminusername,
      clientid: input.clientid,
      contactid: input.contactid,
      status: input.status,
      markdown: input.markdown,
      noemail: input.noemail,
      created: input.created,
    });
    return { data: res, summary: `Reply added to ticket ${String(input.ticketid)}.` };
  },
});

defineTool({
  name: "tickets_add_note",
  domain: "tickets",
  tier: "write",
  whmcsAction: "AddTicketNote",
  description: "Add an internal note to a ticket.",
  inputSchema: ticketsAddNoteInputSchema,
  annotations: { title: "Add an internal note to a ticket", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("AddTicketNote", {
      ticketid: input.ticketid,
      ticketnum: input.ticketnum,
      message: input.message,
      markdown: input.markdown,
    });
    return { data: res, summary: `Note added to ticket ${String(input.ticketid ?? input.ticketnum)}.` };
  },
});

defineTool({
  name: "tickets_update",
  domain: "tickets",
  tier: "write",
  whmcsAction: "UpdateTicket",
  description: "Update ticket metadata (status/department/priority/flag).",
  inputSchema: ticketsUpdateInputSchema,
  annotations: {
    title: "Update ticket metadata (status/department/priority/flag)",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("UpdateTicket", {
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
    });
    return { data: res, summary: `Ticket ${String(input.ticketid)} updated.` };
  },
});

defineTool({
  name: "tickets_update_reply",
  domain: "tickets",
  tier: "write",
  whmcsAction: "UpdateTicketReply",
  description: "Edit an existing ticket reply.",
  inputSchema: ticketsUpdateReplyInputSchema,
  annotations: { title: "Edit an existing ticket reply", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("UpdateTicketReply", {
      replyid: input.replyid,
      message: input.message,
      markdown: input.markdown,
    });
    return { data: res, summary: `Reply ${String(input.replyid)} updated.` };
  },
});

// ---------------------------------------------------------------------------
// Destructive (tier: destructive) — always confirm-gated, regardless of mode
// ---------------------------------------------------------------------------

defineTool({
  name: "tickets_merge",
  domain: "tickets",
  tier: "destructive",
  whmcsAction: "MergeTicket",
  description: "Merge one or more tickets into a target ticket.",
  inputSchema: ticketsMergeInputSchema,
  annotations: { title: "Merge one or more tickets into a target ticket", readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("MergeTicket", {
      ticketid: input.ticketid,
      mergeticketids: input.mergeticketids,
      newsubject: input.newsubject,
    });
    return { data: res, summary: `Ticket(s) [${input.mergeticketids}] merged into ticket ${String(input.ticketid)}.` };
  },
  buildConfirmationPreview: (input) =>
    `Merge ticket(s) [${input.mergeticketids}] into ticket #${String(input.ticketid)}` +
    (input.newsubject ? ` with new subject "${input.newsubject}"` : "") +
    `. This cannot be undone.`,
});

defineTool({
  name: "tickets_delete",
  domain: "tickets",
  tier: "destructive",
  whmcsAction: "DeleteTicket",
  description: "Permanently delete a ticket.",
  inputSchema: ticketsDeleteInputSchema,
  annotations: { title: "Permanently delete a ticket", readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const res = await ctx.whmcs.call("DeleteTicket", { ticketid: input.ticketid });
    return { data: res, summary: `Ticket ${String(input.ticketid)} deleted.` };
  },
  buildConfirmationPreview: (input) =>
    `Permanently delete ticket #${String(input.ticketid)}, including all replies and notes. This cannot be undone.`,
});
