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
 * shared `WhmcsClient.call()` boundary (src/whmcs-client.ts). It also owns
 * no zod schema definitions: every input schema is imported from
 * src/schemas/clients.ts, which is the single source of truth for WHMCS
 * parameter shapes.
 *
 * Safety-shim note: src/safety/confirm.ts and src/safety/redact.ts are
 * planned shared modules (see the architecture plan's fileLayout) that are
 * not present in this checkout yet. Rather than block this domain's tools
 * on files owned by a different pass, this module implements the minimum
 * confirm-token and PII-redaction behavior it needs locally, clearly marked
 * below with "SHARED-SHIM". When src/safety/confirm.ts and
 * src/safety/redact.ts land, these local shims should be deleted in favor
 * of the shared implementations so every domain enforces the exact same
 * confirm-token TTL/single-use semantics and redaction rules.
 */

import { randomUUID, createHash } from "node:crypto";

import { z } from "zod";

import type { ToolRegistrationContext } from "../index.js";
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
  contactPermissionSchema,
} from "../schemas/clients.js";
import { confirmTokenSchema, dryRunSchema } from "../schemas/common.js";
import {
  WhmcsApiError,
  unwrapCollection,
  type WhmcsCallParams,
} from "../whmcs-client.js";
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

const DOMAIN = "clients" as const;

/* ------------------------------------------------------------------------ *
 * SHARED-SHIM: confirm-token flow for the one destructive tool in this file
 * (clients_close). Bound to tool name + a hash of the confirmable args,
 * single-use, 5 minute TTL — matching the semantics the architecture plan
 * assigns to src/safety/confirm.ts. This is a process-local, in-memory
 * store: it does not survive a server restart, which is the correct
 * fail-closed behavior for a confirmation gate (a restarted process should
 * never honor a token minted before it started).
 * ------------------------------------------------------------------------ */

const CONFIRM_TTL_MS = 5 * 60 * 1000;

interface PendingConfirmation {
  argsHash: string;
  expiresAt: number;
}

const pendingConfirmations = new Map<string, PendingConfirmation>();

function hashConfirmableArgs(toolName: string, args: Record<string, unknown>): string {
  const { confirmToken: _omit, dryRun: _omit2, ...confirmable } = args as Record<
    string,
    unknown
  >;
  return createHash("sha256")
    .update(toolName)
    .update(JSON.stringify(confirmable, Object.keys(confirmable).sort()))
    .digest("hex");
}

/** Mints a new confirm token for this exact tool+args pair. */
function mintConfirmToken(toolName: string, args: Record<string, unknown>): string {
  const token = randomUUID();
  pendingConfirmations.set(token, {
    argsHash: hashConfirmableArgs(toolName, args),
    expiresAt: Date.now() + CONFIRM_TTL_MS,
  });
  return token;
}

/**
 * Validates a submitted confirm token against this exact tool+args pair.
 * Single-use: a valid token is deleted whether or not it matches, so a
 * replayed token (accidental or otherwise) never succeeds twice.
 */
function checkConfirmToken(
  toolName: string,
  args: Record<string, unknown>,
  token: string,
): { ok: true } | { ok: false; reason: string } {
  const pending = pendingConfirmations.get(token);
  pendingConfirmations.delete(token);
  if (!pending) {
    return { ok: false, reason: "Unknown, expired, or already-used confirmToken." };
  }
  if (Date.now() > pending.expiresAt) {
    return { ok: false, reason: "confirmToken has expired; request a new preview." };
  }
  if (pending.argsHash !== hashConfirmableArgs(toolName, args)) {
    return {
      ok: false,
      reason:
        "confirmToken does not match the submitted arguments; the preview and the " +
        "executing call must use identical (non-confirmToken) arguments.",
    };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------------ *
 * SHARED-SHIM: PII redaction for client/contact records. Applied whenever
 * `ctx.config.redactPii` is true (the default). Mirrors the scope the
 * architecture plan assigns to src/safety/redact.ts for this domain:
 * WHMCS never returns raw passwords via these actions (ClientRaw.password
 * is always undefined), so the surface here is contact-detail PII, not
 * secrets.
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

/* ------------------------------------------------------------------------ *
 * Small shared helpers
 * ------------------------------------------------------------------------ */

/** Wraps a JSON-serializable value as the tool's single text content block. */
function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

/** Normalizes a caught error into the message a tool should surface. */
function describeError(err: unknown): string {
  if (err instanceof WhmcsApiError) {
    return `WHMCS ${err.action} failed: ${err.whmcsMessage ?? err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * WHMCS's raw client-facing `customfields` map (`{ fieldName: value }`) is
 * form-encoded by the API as `customfields[base64(fieldname)]=value`. This
 * mirrors that encoding for AddClient/UpdateClient, keeping the base64
 * transform out of the tool handlers below.
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
  permissions: Array<z.infer<typeof contactPermissionSchema>> | undefined,
): string | undefined {
  return permissions && permissions.length > 0 ? permissions.join(",") : undefined;
}

export function registerClientTools(ctx: ToolRegistrationContext): void {
  // Policy gate: this entire module no-ops when the "clients" domain is not
  // in WHMCS_MCP_ENABLE_DOMAINS. Per-tool tier gating still applies below —
  // a domain being enabled does not by itself advertise write/destructive
  // tools under WHMCS_MCP_MODE=readonly.
  if (!ctx.isDomainEnabled(DOMAIN)) return;

  const redactPii = ctx.config.redactPii;

  /* ---------------------------------------------------------------------
   * clients_list -> GetClients [read]
   * ------------------------------------------------------------------- */
  if (ctx.isTierAllowed("read")) {
    ctx.server.registerTool(
      "clients_list",
      {
        title: "List WHMCS clients",
        description:
          "Lists WHMCS client accounts (WHMCS action: GetClients), with optional " +
          "free-text search, status filter, and pagination.",
        inputSchema: clientsListInputSchema.shape,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (rawArgs) => {
        const input = clientsListInputSchema.parse(rawArgs);
        try {
          const raw = await ctx.client.call<WhmcsGetClientsRaw>("GetClients", {
            search: input.search,
            status: input.status,
            limitstart: input.limitstart,
            limitnum: input.limitnum,
            orderby: input.orderby,
            sorting: input.sorting,
          });
          const clients = unwrapCollection<ClientRaw>(raw.clients, "client").map((c) =>
            redactClientRecord<Client>(c, redactPii),
          );
          return jsonResult({
            clients,
            totalresults: raw.totalresults,
            startnumber: raw.startnumber,
            numreturned: raw.numreturned,
          });
        } catch (err) {
          return errorResult(describeError(err));
        }
      },
    );
  }

  /* ---------------------------------------------------------------------
   * clients_get -> GetClientsDetails [read]
   * ------------------------------------------------------------------- */
  if (ctx.isTierAllowed("read")) {
    ctx.server.registerTool(
      "clients_get",
      {
        title: "Get WHMCS client details",
        description:
          "Fetches full details for one WHMCS client by clientid or email " +
          "(WHMCS action: GetClientsDetails). Set stats:true to also include " +
          "service/order/domain/ticket/invoice counts.",
        inputSchema: {
          clientid: z.number().int().positive().optional(),
          email: z.string().email().optional(),
          stats: z.boolean().optional(),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (rawArgs) => {
        const input = clientsGetInputSchema.parse(rawArgs);
        try {
          const raw = await ctx.client.call<WhmcsGetClientsDetailsRaw>(
            "GetClientsDetails",
            {
              clientid: input.clientid,
              email: input.email,
              stats: input.stats,
            },
          );
          return jsonResult(redactClientRecord<Client>(raw, redactPii));
        } catch (err) {
          return errorResult(describeError(err));
        }
      },
    );
  }

  /* ---------------------------------------------------------------------
   * clients_create -> AddClient [write]
   * ------------------------------------------------------------------- */
  if (ctx.isTierAllowed("write")) {
    ctx.server.registerTool(
      "clients_create",
      {
        title: "Create a WHMCS client",
        description:
          "Creates a new WHMCS client account (WHMCS action: AddClient). " +
          "Supports dryRun to validate and preview the WHMCS parameters " +
          "without making the network call.",
        inputSchema: clientsCreateInputSchema.shape,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (rawArgs) => {
        const input = clientsCreateInputSchema.parse(rawArgs);
        const params: WhmcsCallParams = {
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
        };
        if (input.dryRun) {
          return jsonResult({ dryRun: true, action: "AddClient", params });
        }
        try {
          const raw = await ctx.client.call<WhmcsAddClientResult>("AddClient", params);
          return jsonResult({ clientid: raw.clientid });
        } catch (err) {
          return errorResult(describeError(err));
        }
      },
    );
  }

  /* ---------------------------------------------------------------------
   * clients_update -> UpdateClient [write]
   * ------------------------------------------------------------------- */
  if (ctx.isTierAllowed("write")) {
    ctx.server.registerTool(
      "clients_update",
      {
        title: "Update a WHMCS client",
        description:
          "Updates fields on an existing WHMCS client, identified by clientid " +
          "or clientemail (WHMCS action: UpdateClient). Supports dryRun.",
        inputSchema: {
          clientid: z.number().int().positive().optional(),
          clientemail: z.string().email().optional(),
          firstname: z.string().trim().min(1).optional(),
          lastname: z.string().trim().min(1).optional(),
          companyname: z.string().trim().optional(),
          email: z.string().email().optional(),
          address1: z.string().trim().min(1).optional(),
          address2: z.string().trim().optional(),
          city: z.string().trim().min(1).optional(),
          state: z.string().trim().min(1).optional(),
          postcode: z.string().trim().min(1).optional(),
          country: z.string().length(2).optional(),
          phonenumber: z.string().trim().min(1).optional(),
          status: z.enum(["Active", "Inactive", "Closed"]).optional(),
          notes: z.string().optional(),
          groupid: z.number().int().positive().optional(),
          credit: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
          clearcreditcard: z.boolean().optional(),
          customfields: z.record(z.string(), z.string()).optional(),
          dryRun: dryRunSchema,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (rawArgs) => {
        const input = clientsUpdateInputSchema.parse(rawArgs);
        const params: WhmcsCallParams = {
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
        };
        if (input.dryRun) {
          return jsonResult({ dryRun: true, action: "UpdateClient", params });
        }
        try {
          const raw = await ctx.client.call<WhmcsUpdateClientResult>(
            "UpdateClient",
            params,
          );
          return jsonResult({ clientid: raw.clientid });
        } catch (err) {
          return errorResult(describeError(err));
        }
      },
    );
  }

  /* ---------------------------------------------------------------------
   * clients_close -> CloseClient [destructive, confirm-gated]
   *
   * Two-step flow: the first call (no confirmToken) returns a preview plus
   * a short-lived confirmToken; the second call must echo that exact token
   * alongside the identical clientid. See the SHARED-SHIM section above.
   * ------------------------------------------------------------------- */
  if (ctx.isTierAllowed("destructive")) {
    ctx.server.registerTool(
      "clients_close",
      {
        title: "Close a WHMCS client account",
        description:
          "Closes a WHMCS client account (WHMCS action: CloseClient). " +
          "Irreversible via the API. Two-step confirm-gated: call once " +
          "without confirmToken to preview and receive a token, then call " +
          "again with the same clientid and that confirmToken to execute.",
        inputSchema: {
          clientid: z.number().int().positive(),
          confirmToken: confirmTokenSchema,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (rawArgs) => {
        const input = clientsCloseInputSchema.parse(rawArgs);
        const confirmableArgs = { clientid: input.clientid };

        if (!input.confirmToken) {
          const confirmToken = mintConfirmToken("clients_close", confirmableArgs);
          return jsonResult({
            preview: true,
            action: "CloseClient",
            clientid: input.clientid,
            warning:
              "This permanently closes the client account in WHMCS. Call " +
              "clients_close again with this confirmToken and the same " +
              "clientid within 5 minutes to execute.",
            confirmToken,
          });
        }

        const check = checkConfirmToken(
          "clients_close",
          confirmableArgs,
          input.confirmToken,
        );
        if (!check.ok) {
          return errorResult(`clients_close not executed: ${check.reason}`);
        }

        try {
          await ctx.client.call<WhmcsCloseClientResult>("CloseClient", {
            clientid: input.clientid,
          });
          return jsonResult({ closed: true, clientid: input.clientid });
        } catch (err) {
          return errorResult(describeError(err));
        }
      },
    );
  }

  /* ---------------------------------------------------------------------
   * clients_get_contacts -> GetContacts [read]
   * ------------------------------------------------------------------- */
  if (ctx.isTierAllowed("read")) {
    ctx.server.registerTool(
      "clients_get_contacts",
      {
        title: "List WHMCS client contacts",
        description:
          "Lists sub-account contacts for a client, or searches contacts " +
          "across clients by name/email (WHMCS action: GetContacts).",
        inputSchema: clientsGetContactsInputSchema.shape,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (rawArgs) => {
        const input = clientsGetContactsInputSchema.parse(rawArgs);
        try {
          const raw = await ctx.client.call<WhmcsGetContactsRaw>("GetContacts", {
            userid: input.userid,
            firstname: input.firstname,
            lastname: input.lastname,
            email: input.email,
            limitstart: input.limitstart,
            limitnum: input.limitnum,
          });
          const contacts = unwrapCollection<Contact>(raw.contacts, "contact").map((c) =>
            redactContactRecord(c, redactPii),
          );
          return jsonResult({ contacts });
        } catch (err) {
          return errorResult(describeError(err));
        }
      },
    );
  }

  /* ---------------------------------------------------------------------
   * clients_add_contact -> AddContact [write]
   * ------------------------------------------------------------------- */
  if (ctx.isTierAllowed("write")) {
    ctx.server.registerTool(
      "clients_add_contact",
      {
        title: "Add a WHMCS client contact",
        description:
          "Adds a sub-account contact to a WHMCS client (WHMCS action: " +
          "AddContact), with optional permission flags and email preferences.",
        inputSchema: {
          clientid: z.number().int().positive(),
          firstname: z.string().trim().min(1),
          lastname: z.string().trim().min(1),
          email: z.string().email(),
          phonenumber: z.string().trim().optional(),
          permissions: z.array(contactPermissionSchema).optional(),
          emailoptin_general: z.boolean().optional(),
          emailoptin_products: z.boolean().optional(),
          emailoptin_domains: z.boolean().optional(),
          emailoptin_invoices: z.boolean().optional(),
          emailoptin_support: z.boolean().optional(),
          emailoptin_affiliates: z.boolean().optional(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (rawArgs) => {
        const input = clientsAddContactInputSchema.parse(rawArgs);
        try {
          const raw = await ctx.client.call<WhmcsAddContactResult>("AddContact", {
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
          return jsonResult({ contactid: raw.contactid });
        } catch (err) {
          return errorResult(describeError(err));
        }
      },
    );
  }

  /* ---------------------------------------------------------------------
   * clients_update_contact -> UpdateContact [write]
   * ------------------------------------------------------------------- */
  if (ctx.isTierAllowed("write")) {
    ctx.server.registerTool(
      "clients_update_contact",
      {
        title: "Update a WHMCS client contact",
        description:
          "Updates fields on an existing sub-account contact (WHMCS action: " +
          "UpdateContact), identified by contactid.",
        inputSchema: {
          contactid: z.number().int().positive(),
          firstname: z.string().trim().min(1).optional(),
          lastname: z.string().trim().min(1).optional(),
          email: z.string().email().optional(),
          phonenumber: z.string().trim().optional(),
          companyname: z.string().trim().optional(),
          address1: z.string().trim().optional(),
          address2: z.string().trim().optional(),
          city: z.string().trim().optional(),
          state: z.string().trim().optional(),
          postcode: z.string().trim().optional(),
          country: z.string().length(2).optional(),
          permissions: z.array(contactPermissionSchema).optional(),
          emailoptin_general: z.boolean().optional(),
          emailoptin_products: z.boolean().optional(),
          emailoptin_domains: z.boolean().optional(),
          emailoptin_invoices: z.boolean().optional(),
          emailoptin_support: z.boolean().optional(),
          emailoptin_affiliates: z.boolean().optional(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (rawArgs) => {
        const input = clientsUpdateContactInputSchema.parse(rawArgs);
        try {
          await ctx.client.call("UpdateContact", {
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
          return jsonResult({ contactid: input.contactid, updated: true });
        } catch (err) {
          return errorResult(describeError(err));
        }
      },
    );
  }

  /* ---------------------------------------------------------------------
   * clients_get_emails -> GetEmails [read]
   * ------------------------------------------------------------------- */
  if (ctx.isTierAllowed("read")) {
    ctx.server.registerTool(
      "clients_get_emails",
      {
        title: "List emails sent to a WHMCS client",
        description:
          "Lists emails WHMCS has sent to a client's account, optionally " +
          "filtered by date or subject (WHMCS action: GetEmails).",
        inputSchema: clientsGetEmailsInputSchema.shape,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (rawArgs) => {
        const input = clientsGetEmailsInputSchema.parse(rawArgs);
        try {
          const raw = await ctx.client.call<WhmcsGetEmailsRaw>("GetEmails", {
            clientid: input.clientid,
            date: input.date,
            subject: input.subject,
            limitstart: input.limitstart,
            limitnum: input.limitnum,
          });
          const emails = unwrapCollection<WhmcsClientEmail>(raw.emails, "email");
          return jsonResult({ emails });
        } catch (err) {
          return errorResult(describeError(err));
        }
      },
    );
  }

  /* ---------------------------------------------------------------------
   * clients_get_groups -> GetClientGroups [read]
   * ------------------------------------------------------------------- */
  if (ctx.isTierAllowed("read")) {
    ctx.server.registerTool(
      "clients_get_groups",
      {
        title: "List WHMCS client groups",
        description:
          "Lists the client groups configured in WHMCS (WHMCS action: " +
          "GetClientGroups). No inputs.",
        inputSchema: clientsGetGroupsInputSchema.shape,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async () => {
        try {
          const raw = await ctx.client.call<WhmcsClientGroupsRaw>(
            "GetClientGroups",
            {},
          );
          const groups = unwrapCollection<WhmcsClientGroup>(raw.groups, "group");
          return jsonResult({ groups });
        } catch (err) {
          return errorResult(describeError(err));
        }
      },
    );
  }
}
