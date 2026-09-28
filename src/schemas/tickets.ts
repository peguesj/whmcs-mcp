/**
 * src/schemas/tickets.ts
 *
 * Zod input schemas for every `tickets_*` MCP tool (domain: "tickets" in the
 * architecture plan's toolList). Each schema mirrors the parameters
 * documented for the corresponding WHMCS External API action at
 * https://developers.whmcs.com/api-reference/ — verified compatible with the
 * 8.12.x and 9.0.x contract (action names and parameters are unchanged across
 * that range).
 *
 * These are INPUT schemas only: they describe what an MCP tool call accepts.
 * The actual HTTP request/auth/response-normalization lives in
 * src/whmcs-client.ts. Serialization from a schema's shape into WHMCS's
 * flat form-encoded params (e.g. base64 customfields, CSV lists) is the
 * responsibility of src/tools/tickets.ts, which owns these schemas' tool
 * registrations.
 *
 * Tiers (read | write | billing | destructive) are attached here as metadata
 * alongside each schema so src/tools/registry.ts can apply WHMCS_MCP_MODE /
 * WHMCS_MCP_ENABLE_DOMAINS filtering and the two-step confirm flow without
 * re-deriving the tier from the plan by hand.
 */

import { z } from "zod";
import {
  confirmTokenSchema,
  dryRunSchema,
  idSchema,
  paginationSchema,
} from "./common.js";

/** WHMCS's documented support ticket statuses (GetTickets `status` filter). */
export const ticketStatusSchema = z.union([
  z.enum([
    "Open",
    "Answered",
    "Customer-Reply",
    "Closed",
    "On Hold",
    "In Progress",
  ]),
  // GetTickets also accepts these special aggregate filters.
  z.enum(["Awaiting Reply", "All Active Tickets", "My Flagged Tickets"]),
  // WHMCS also tolerates arbitrary custom statuses configured per-install.
  z.string().min(1),
]);

export const ticketPrioritySchema = z.enum(["Low", "Medium", "High"]);

export const ticketReplySortSchema = z.enum(["ASC", "DESC"]);

/** GetTicketAttachment's `type` parameter: what kind of entity owns the file. */
export const ticketAttachmentTypeSchema = z.enum(["ticket", "reply", "note"]);

// ---------------------------------------------------------------------------
// tickets_list -> WHMCS action: GetTickets
// ---------------------------------------------------------------------------
export const ticketsListInputSchema = paginationSchema.extend({
  deptid: idSchema.optional(),
  clientid: idSchema.optional(),
  email: z.string().email().optional(),
  status: ticketStatusSchema.optional(),
  subject: z.string().optional(),
  ignore_dept_assignments: z.boolean().optional(),
});
export type TicketsListInput = z.infer<typeof ticketsListInputSchema>;

// ---------------------------------------------------------------------------
// tickets_get -> WHMCS action: GetTicket
// ---------------------------------------------------------------------------
export const ticketsGetInputSchema = z
  .object({
    ticketnum: z.string().optional(),
    ticketid: idSchema.optional(),
    repliessort: ticketReplySortSchema.optional(),
  })
  .refine((v) => v.ticketnum !== undefined || v.ticketid !== undefined, {
    message: "Provide either ticketnum or ticketid",
  });
export type TicketsGetInput = z.infer<typeof ticketsGetInputSchema>;

// ---------------------------------------------------------------------------
// tickets_create -> WHMCS action: OpenTicket
// ---------------------------------------------------------------------------
export const ticketsCreateInputSchema = z
  .object({
    deptid: idSchema,
    subject: z.string().min(1),
    message: z.string().min(1),
    clientid: idSchema.optional(),
    contactid: idSchema.optional(),
    name: z.string().optional(),
    email: z.string().email().optional(),
    priority: ticketPrioritySchema.optional(),
    serviceid: idSchema.optional(),
    domainid: idSchema.optional(),
    admin: z.boolean().optional(),
    markdown: z.boolean().optional(),
    // Serialized to WHMCS's base64-encoded custom field map by the tool
    // handler; kept as a plain string record at the schema boundary.
    customfields: z.record(z.string(), z.string()).optional(),
    dryRun: dryRunSchema,
  })
  .refine(
    (v) =>
      v.clientid !== undefined ||
      v.contactid !== undefined ||
      (v.name !== undefined && v.email !== undefined),
    {
      message:
        "Provide clientid, or contactid, or both name and email for a guest/prospect ticket",
    },
  );
export type TicketsCreateInput = z.infer<typeof ticketsCreateInputSchema>;

// ---------------------------------------------------------------------------
// tickets_reply -> WHMCS action: AddTicketReply
// ---------------------------------------------------------------------------
export const ticketsReplyInputSchema = z.object({
  ticketid: idSchema,
  message: z.string().min(1),
  adminusername: z.string().optional(),
  clientid: idSchema.optional(),
  contactid: idSchema.optional(),
  status: ticketStatusSchema.optional(),
  markdown: z.boolean().optional(),
  noemail: z.boolean().optional(),
  // ISO 8601 or WHMCS "YYYY-MM-DD HH:MM:SS"; validated loosely here, the
  // client layer normalizes to WHMCS's expected format.
  created: z.string().optional(),
  dryRun: dryRunSchema,
});
export type TicketsReplyInput = z.infer<typeof ticketsReplyInputSchema>;

// ---------------------------------------------------------------------------
// tickets_add_note -> WHMCS action: AddTicketNote
// ---------------------------------------------------------------------------
export const ticketsAddNoteInputSchema = z
  .object({
    ticketid: idSchema.optional(),
    ticketnum: z.string().optional(),
    message: z.string().min(1),
    markdown: z.boolean().optional(),
  })
  .refine((v) => v.ticketid !== undefined || v.ticketnum !== undefined, {
    message: "Provide either ticketid or ticketnum",
  });
export type TicketsAddNoteInput = z.infer<typeof ticketsAddNoteInputSchema>;

// ---------------------------------------------------------------------------
// tickets_get_notes -> WHMCS action: GetTicketNotes
// ---------------------------------------------------------------------------
export const ticketsGetNotesInputSchema = z.object({
  ticketid: idSchema,
});
export type TicketsGetNotesInput = z.infer<typeof ticketsGetNotesInputSchema>;

// ---------------------------------------------------------------------------
// tickets_update -> WHMCS action: UpdateTicket
// ---------------------------------------------------------------------------
export const ticketsUpdateInputSchema = z.object({
  ticketid: idSchema,
  status: ticketStatusSchema.optional(),
  deptid: idSchema.optional(),
  subject: z.string().optional(),
  priority: ticketPrioritySchema.optional(),
  /** Admin id to flag this ticket to, per WHMCS's `flag` parameter. */
  flag: idSchema.optional(),
  userid: idSchema.optional(),
  email: z.string().email().optional(),
  cc: z.string().optional(),
  removeFlag: z.boolean().optional(),
  dryRun: dryRunSchema,
});
export type TicketsUpdateInput = z.infer<typeof ticketsUpdateInputSchema>;

// ---------------------------------------------------------------------------
// tickets_update_reply -> WHMCS action: UpdateTicketReply
// ---------------------------------------------------------------------------
export const ticketsUpdateReplyInputSchema = z.object({
  replyid: idSchema,
  message: z.string().min(1),
  markdown: z.boolean().optional(),
});
export type TicketsUpdateReplyInput = z.infer<
  typeof ticketsUpdateReplyInputSchema
>;

// ---------------------------------------------------------------------------
// tickets_merge -> WHMCS action: MergeTicket  [destructive, confirm]
// ---------------------------------------------------------------------------
export const ticketsMergeInputSchema = z.object({
  /** Target ticket that survives the merge. */
  ticketid: idSchema,
  /** CSV list of ticket ids to merge into `ticketid`. */
  mergeticketids: z.string().min(1),
  newsubject: z.string().optional(),
  /** Required on the second call, echoing the token from the preview call. */
  confirmToken: confirmTokenSchema,
});
export type TicketsMergeInput = z.infer<typeof ticketsMergeInputSchema>;

// ---------------------------------------------------------------------------
// tickets_delete -> WHMCS action: DeleteTicket  [destructive, confirm]
// ---------------------------------------------------------------------------
export const ticketsDeleteInputSchema = z.object({
  ticketid: idSchema,
  confirmToken: confirmTokenSchema,
});
export type TicketsDeleteInput = z.infer<typeof ticketsDeleteInputSchema>;

// ---------------------------------------------------------------------------
// tickets_get_attachment -> WHMCS action: GetTicketAttachment
// ---------------------------------------------------------------------------
export const ticketsGetAttachmentInputSchema = z.object({
  relatedid: idSchema,
  type: ticketAttachmentTypeSchema,
  index: z.number().int().min(0),
});
export type TicketsGetAttachmentInput = z.infer<
  typeof ticketsGetAttachmentInputSchema
>;

// ---------------------------------------------------------------------------
// tickets_get_counts -> WHMCS action: GetTicketCounts
// ---------------------------------------------------------------------------
export const ticketsGetCountsInputSchema = z.object({
  ignoreDepartmentAssignments: z.boolean().optional(),
  includeCountsByStatus: z.boolean().optional(),
});
export type TicketsGetCountsInput = z.infer<typeof ticketsGetCountsInputSchema>;

// ---------------------------------------------------------------------------
// tickets_get_departments -> WHMCS action: GetSupportDepartments
// ---------------------------------------------------------------------------
export const ticketsGetDepartmentsInputSchema = z.object({
  ignore_dept_assignments: z.boolean().optional(),
});
export type TicketsGetDepartmentsInput = z.infer<
  typeof ticketsGetDepartmentsInputSchema
>;

// ---------------------------------------------------------------------------
// tickets_get_statuses -> WHMCS action: GetSupportStatuses
// ---------------------------------------------------------------------------
export const ticketsGetStatusesInputSchema = z.object({
  deptid: idSchema.optional(),
});
export type TicketsGetStatusesInput = z.infer<
  typeof ticketsGetStatusesInputSchema
>;

// ---------------------------------------------------------------------------
// tickets_get_predefined_replies -> WHMCS action: GetTicketPredefinedReplies
// ---------------------------------------------------------------------------
export const ticketsGetPredefinedRepliesInputSchema = z.object({
  catid: idSchema.optional(),
});
export type TicketsGetPredefinedRepliesInput = z.infer<
  typeof ticketsGetPredefinedRepliesInputSchema
>;

// ---------------------------------------------------------------------------
// Registry metadata: one entry per tickets_* tool, consumed by
// src/tools/tickets.ts and src/tools/registry.ts. Keeping this table here
// (next to the schemas it references) keeps tier/action/schema in sync by
// construction instead of by hand-maintained duplication across files.
// ---------------------------------------------------------------------------

export type ToolTier = "read" | "write" | "billing" | "destructive";

export interface TicketToolDefinition {
  name: string;
  whmcsAction: string;
  tier: ToolTier;
  schema: z.ZodTypeAny;
}

export const TICKETS_TOOL_DEFINITIONS: readonly TicketToolDefinition[] = [
  { name: "tickets_list", whmcsAction: "GetTickets", tier: "read", schema: ticketsListInputSchema },
  { name: "tickets_get", whmcsAction: "GetTicket", tier: "read", schema: ticketsGetInputSchema },
  { name: "tickets_create", whmcsAction: "OpenTicket", tier: "write", schema: ticketsCreateInputSchema },
  { name: "tickets_reply", whmcsAction: "AddTicketReply", tier: "write", schema: ticketsReplyInputSchema },
  { name: "tickets_add_note", whmcsAction: "AddTicketNote", tier: "write", schema: ticketsAddNoteInputSchema },
  { name: "tickets_get_notes", whmcsAction: "GetTicketNotes", tier: "read", schema: ticketsGetNotesInputSchema },
  { name: "tickets_update", whmcsAction: "UpdateTicket", tier: "write", schema: ticketsUpdateInputSchema },
  { name: "tickets_update_reply", whmcsAction: "UpdateTicketReply", tier: "write", schema: ticketsUpdateReplyInputSchema },
  { name: "tickets_merge", whmcsAction: "MergeTicket", tier: "destructive", schema: ticketsMergeInputSchema },
  { name: "tickets_delete", whmcsAction: "DeleteTicket", tier: "destructive", schema: ticketsDeleteInputSchema },
  { name: "tickets_get_attachment", whmcsAction: "GetTicketAttachment", tier: "read", schema: ticketsGetAttachmentInputSchema },
  { name: "tickets_get_counts", whmcsAction: "GetTicketCounts", tier: "read", schema: ticketsGetCountsInputSchema },
  { name: "tickets_get_departments", whmcsAction: "GetSupportDepartments", tier: "read", schema: ticketsGetDepartmentsInputSchema },
  { name: "tickets_get_statuses", whmcsAction: "GetSupportStatuses", tier: "read", schema: ticketsGetStatusesInputSchema },
  { name: "tickets_get_predefined_replies", whmcsAction: "GetTicketPredefinedReplies", tier: "read", schema: ticketsGetPredefinedRepliesInputSchema },
] as const;
