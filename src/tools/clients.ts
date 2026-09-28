/**
 * src/tools/clients.ts
 *
 * MCP tool registrations for the `clients` domain: WHMCS client accounts
 * and their sub-account contacts. Every tool here maps 1:1 to a WHMCS
 * External API action, per the architecture plan's toolList entries whose
 * `domain` is "clients":
 *
 *   clients_list           -> GetClients            [read]
 *   clients_get             -> GetClientsDetails     [read]
 *   clients_create           -> AddClient             [write]
 *   clients_update            -> UpdateClient          [write]
 *   clients_close              -> CloseClient           [destructive, confirm-gated]
 *   clients_get_contacts         -> GetContacts           [read]
 *   clients_add_contact            -> AddContact            [write]
 *   clients_update_contact           -> UpdateContact         [write]
 *   clients_get_emails                 -> GetEmails             [read]
 *   clients_get_groups                   -> GetClientGroups       [read]
 *
 * `clients_get_services` / `clients_get_addons` are intentionally NOT here —
 * the architecture plan assigns them `domain: "products"` even though their
 * tool names start with `clients_`; see src/tools/products.ts.
 *
 * This module owns no network I/O itself: every WHMCS call goes through the
 * shared `WhmcsClient.call()` boundary (src/whmcs-client.ts), reached via
 * `ctx.whmcs.call(...)` inside each `defineTool` handler. Registration/tier/
 * mode gating, dryRun short-circuiting, the two-step confirm-token flow for
 * `clients_close`, and output redaction of the raw WHMCS response are all
 * handled centrally by `defineTool` (src/tools/registry.ts) and
 * `src/safety/redact.ts`. The masking helpers below cover the one thing the
 * shared redaction layer does not know: which of a Client/Contact record's
 * fields are contact PII versus structural data.
 */

import type { z } from "zod";

import { defineTool, type ToolContext, type ToolHandlerResult } from "./registry.js";
import {
  clientsAddContactInputSchema,
  clientsCloseInputSchema,
  clientsCreateInputSchema,
  clientsGetContactsInputSchema,
  clientsGetEmailsInputSchema,
  clientsGetGroupsInputSchema,
  clientsGetInputSchema,
  clientsListInputSchema,
  clientsUpdateContactInputSchema,
  clientsUpdateInputSchema,
  type contactPermissionSchema,
} from "../schemas/clients.js";
import { unwrapCollection, type WhmcsCallParams } from "../whmcs-client.js";
import type {
  Client,
  ClientRaw,
  Contact,
  WhmcsAddClientResult,
  WhmcsAddContactResult,
  WhmcsClientEmail,
  WhmcsClientGroup,
  WhmcsCloseClientResult,
  WhmcsGetClientsDetailsRaw,
  WhmcsGetClientsRaw,
  WhmcsGetContactsRaw,
  WhmcsGetEmailsRaw,
  WhmcsClientGroupsRaw,
  WhmcsUpdateClientResult,
} from "../types/whmcs.js";

/* ------------------------------------------------------------------------ *
 * Domain-specific PII masking for client/contact records. Applied whenever
 * `ctx.config.redactPii` is true (the default). WHMCS never returns raw
 * passwords via these actions (ClientRaw.password is always undefined), so
 * the surface here is contact-detail PII, not secrets.
 * ------------------------------------------------------------------------ */

function maskEmail(email: string | undefined): string | undefined {
  if (!email) return email;
  const [user, host] = email.split("@");
  if (!host || !user) return "***";
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}${"*".repeat(Math.max(1, user.length - visible.length))}@${host}`;
}

function maskPhone(phone: string | undefined): string | undefined {
  if (!phone) return phone;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***-${digits.slice(-4)}`;
}

function redactClientRecord<T extends Partial<ClientRaw>>(client: T, redact: boolean): T {
  if (!redact) return client;
  return {
    ...client,
    email: maskEmail(client.email) as T["email"],
    phonenumber: maskPhone(client.phonenumber) as T["phonenumber"],
    address1: client.address1 ? "[redacted]" : client.address1,
    address2: client.address2 ? "[redacted]" : client.address2,
  };
}

function redactContactRecord<T extends Partial<Contact>>(contact: T, redact: boolean): T {
  if (!redact) return contact;
  return {
    ...contact,
    email: maskEmail(contact.email) as T["email"],
    phonenumber: maskPhone(contact.phonenumber) as T["phonenumber"],
    address1: contact.address1 ? "[redacted]" : contact.address1,
    address2: contact.address2 ? "[redacted]" : contact.address2,
  };
}

/**
 * WHMCS's raw client-facing `customfields` map (`{ fieldName: value }`) is
 * form-encoded by the API as `customfields[base64(fieldname)]=value`.
 */
function encodeCustomFields(
  customfields: Record<string, string> | undefined,
): WhmcsCallParams {
  if (!customfields) return {};
  const out: WhmcsCallParams = {};
  for (const [name, value] of Object.entries(customfields)) {
    out[`customfields[${Buffer.from(name, "utf8").toString("base64")}]`] = value;
  }
  return out;
}

/** Joins a typed permissions array into WHMCS's comma-separated wire format. */
function encodePermissions(
  permissions: z.output<typeof contactPermissionSchema>[] | undefined,
): string | undefined {
  return permissions && permissions.length > 0 ? permissions.join(",") : undefined;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

defineTool({
  name: "clients_list",
  domain: "clients",
  tier: "read",
  whmcsAction: "GetClients",
  description:
    "Lists WHMCS client accounts, with optional free-text search, status filter, and pagination.",
  inputSchema: clientsListInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsGetClientsRaw>("GetClients", {
      search: input.search,
      status: input.status,
      limitstart: input.limitstart,
      limitnum: input.limitnum,
      orderby: input.orderby,
      sorting: input.sorting,
    });
    const clients = unwrapCollection<ClientRaw>(raw, "client").map((c) =>
      redactClientRecord<Client>(c, ctx.config.redactPii),
    );
    return {
      data: {
        clients,
        totalresults: raw.totalresults,
        startnumber: raw.startnumber,
        numreturned: raw.numreturned,
      },
    };
  },
});

defineTool({
  name: "clients_get",
  domain: "clients",
  tier: "read",
  whmcsAction: "GetClientsDetails",
  description:
    "Fetches full details for one WHMCS client by clientid or email. Set stats:true to also include " +
    "service/order/domain/ticket/invoice counts.",
  inputSchema: clientsGetInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsGetClientsDetailsRaw>("GetClientsDetails", {
      clientid: input.clientid,
      email: input.email,
      stats: input.stats,
    });
    return { data: redactClientRecord<Client>(raw, ctx.config.redactPii) };
  },
});

defineTool({
  name: "clients_get_contacts",
  domain: "clients",
  tier: "read",
  whmcsAction: "GetContacts",
  description:
    "Lists sub-account contacts for a client, or searches contacts across clients by name/email.",
  inputSchema: clientsGetContactsInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsGetContactsRaw>("GetContacts", {
      userid: input.userid,
      firstname: input.firstname,
      lastname: input.lastname,
      email: input.email,
      limitstart: input.limitstart,
      limitnum: input.limitnum,
    });
    const contacts = unwrapCollection<Contact>(raw, "contact").map((c) =>
      redactContactRecord(c, ctx.config.redactPii),
    );
    return { data: { contacts } };
  },
});

defineTool({
  name: "clients_get_emails",
  domain: "clients",
  tier: "read",
  whmcsAction: "GetEmails",
  description: "Lists emails WHMCS has sent to a client's account, optionally filtered by date or subject.",
  inputSchema: clientsGetEmailsInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsGetEmailsRaw>("GetEmails", {
      clientid: input.clientid,
      date: input.date,
      subject: input.subject,
      limitstart: input.limitstart,
      limitnum: input.limitnum,
    });
    const emails = unwrapCollection<WhmcsClientEmail>(raw, "email");
    return { data: { emails } };
  },
});

defineTool({
  name: "clients_get_groups",
  domain: "clients",
  tier: "read",
  whmcsAction: "GetClientGroups",
  description: "Lists the client groups configured in WHMCS. No inputs.",
  inputSchema: clientsGetGroupsInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (_input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsClientGroupsRaw>("GetClientGroups", {});
    const groups = unwrapCollection<WhmcsClientGroup>(raw, "group");
    return { data: { groups } };
  },
});

// ---------------------------------------------------------------------------
// Writes (tier: write)
// ---------------------------------------------------------------------------

defineTool({
  name: "clients_create",
  domain: "clients",
  tier: "write",
  whmcsAction: "AddClient",
  description: "Creates a new WHMCS client account.",
  inputSchema: clientsCreateInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsAddClientResult>("AddClient", {
      firstname: input.firstname,
      lastname: input.lastname,
      email: input.email,
      address1: input.address1,
      city: input.city,
      state: input.state,
      postcode: input.postcode,
      country: input.country,
      phonenumber: input.phonenumber,
      companyname: input.companyname,
      currency: input.currency,
      groupid: input.groupid,
      language: input.language,
      skipvalidation: input.skipvalidation,
      noemail: input.noemail,
      ...encodeCustomFields(input.customfields),
    });
    return { data: { clientid: raw.clientid }, summary: `Client ${String(raw.clientid)} created.` };
  },
});

defineTool({
  name: "clients_update",
  domain: "clients",
  tier: "write",
  whmcsAction: "UpdateClient",
  description: "Updates fields on an existing WHMCS client, identified by clientid or clientemail.",
  inputSchema: clientsUpdateInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsUpdateClientResult>("UpdateClient", {
      clientid: input.clientid,
      clientemail: input.clientemail,
      firstname: input.firstname,
      lastname: input.lastname,
      companyname: input.companyname,
      email: input.email,
      address1: input.address1,
      address2: input.address2,
      city: input.city,
      state: input.state,
      postcode: input.postcode,
      country: input.country,
      phonenumber: input.phonenumber,
      status: input.status,
      notes: input.notes,
      groupid: input.groupid,
      credit: input.credit,
      clearcreditcard: input.clearcreditcard,
      ...encodeCustomFields(input.customfields),
    });
    return { data: { clientid: raw.clientid }, summary: `Client ${String(raw.clientid)} updated.` };
  },
});

defineTool({
  name: "clients_add_contact",
  domain: "clients",
  tier: "write",
  whmcsAction: "AddContact",
  description: "Adds a sub-account contact to a WHMCS client, with optional permission flags and email preferences.",
  inputSchema: clientsAddContactInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    const raw = await ctx.whmcs.call<WhmcsAddContactResult>("AddContact", {
      clientid: input.clientid,
      firstname: input.firstname,
      lastname: input.lastname,
      email: input.email,
      phonenumber: input.phonenumber,
      permissions: encodePermissions(input.permissions),
      emailoptin_general: input.emailoptin_general,
      emailoptin_products: input.emailoptin_products,
      emailoptin_domains: input.emailoptin_domains,
      emailoptin_invoices: input.emailoptin_invoices,
      emailoptin_support: input.emailoptin_support,
      emailoptin_affiliates: input.emailoptin_affiliates,
    });
    return { data: { contactid: raw.contactid }, summary: `Contact ${String(raw.contactid)} added to client ${String(input.clientid)}.` };
  },
});

defineTool({
  name: "clients_update_contact",
  domain: "clients",
  tier: "write",
  whmcsAction: "UpdateContact",
  description: "Updates fields on an existing sub-account contact, identified by contactid.",
  inputSchema: clientsUpdateContactInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    await ctx.whmcs.call("UpdateContact", {
      contactid: input.contactid,
      firstname: input.firstname,
      lastname: input.lastname,
      email: input.email,
      phonenumber: input.phonenumber,
      companyname: input.companyname,
      address1: input.address1,
      address2: input.address2,
      city: input.city,
      state: input.state,
      postcode: input.postcode,
      country: input.country,
      permissions: encodePermissions(input.permissions),
      emailoptin_general: input.emailoptin_general,
      emailoptin_products: input.emailoptin_products,
      emailoptin_domains: input.emailoptin_domains,
      emailoptin_invoices: input.emailoptin_invoices,
      emailoptin_support: input.emailoptin_support,
      emailoptin_affiliates: input.emailoptin_affiliates,
    });
    return { data: { contactid: input.contactid, updated: true }, summary: `Contact ${String(input.contactid)} updated.` };
  },
});

// ---------------------------------------------------------------------------
// Destructive (tier: destructive) — confirm-gated
// ---------------------------------------------------------------------------

defineTool({
  name: "clients_close",
  domain: "clients",
  tier: "destructive",
  whmcsAction: "CloseClient",
  description:
    "Closes a WHMCS client account. Irreversible via the API. Two-step confirm-gated: call once " +
    "without confirmToken to preview and receive a token, then call again with the same clientid and " +
    "that confirmToken to execute.",
  inputSchema: clientsCloseInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  handler: async (input, ctx: ToolContext): Promise<ToolHandlerResult> => {
    await ctx.whmcs.call<WhmcsCloseClientResult>("CloseClient", { clientid: input.clientid });
    return { data: { closed: true, clientid: input.clientid }, summary: `Client ${String(input.clientid)} closed.` };
  },
  buildConfirmationPreview: (input) =>
    `This permanently closes client ${String(input.clientid)}'s account in WHMCS. This cannot be undone.`,
});
