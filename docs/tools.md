# Tool Reference

> Generated reference for every MCP tool exposed by `@peguesj/whmcs-mcp`. This file mirrors
> the tool registry (`src/tools/*.ts`) and the per-domain zod schemas (`src/schemas/*.ts`).
> Regenerate with `npm run gen:docs` (`scripts/gen-docs.ts`) after changing any tool or schema —
> CI's `gen:docs` drift check fails the build if this file is stale.

## Tiers and modes

| Tier | Meaning | Advertised when |
|---|---|---|
| `read` | Read-only WHMCS API call. No confirmation required. | Always (`WHMCS_MCP_MODE=readonly` default, `write`, or `full`) |
| `write` | Mutates WHMCS state but is reversible / low blast-radius. Supports `dryRun`. | `WHMCS_MCP_MODE=write` or `full` |
| `billing` | Mutates billing, invoices, orders, or domain registration/transfer. Two-step confirm required (`confirmToken`). | `WHMCS_MCP_MODE=full` only |
| `destructive` | Irreversible (delete/merge/cancel/fraud-mark). Two-step confirm required (`confirmToken`). | `WHMCS_MCP_MODE=write` or `full`, per-tool as noted |

`WHMCS_MCP_ENABLE_DOMAINS` further filters by domain (e.g. `tickets,clients`) independent of tier.
See `docs/configuration.md` for the full mode/domain matrix and `SECURITY.md` for the least-privilege
WHMCS API Role recipe. Per the operator's standing "invoices are operator-manual" policy, every
`billing_*` invoice-mutation tool ships gated behind `full` mode and must stay disabled in any
3VS-managed deployment config.

---

## system — `src/tools/system.ts`

| Tool | Tier | WHMCS Action | Parameters |
|---|---|---|---|
| `system_get_details` | read | `WhmcsDetails` | *(none)* — returns `whmcs.version`; used for runtime version discovery/compat checks |
| `system_get_stats` | read | `GetStats` | `timeline_days?: int` |
| `system_get_activity_log` | read | `GetActivityLog` | `limitstart?: int`, `limitnum?: int (<=250)`, `clientid?: int`, `date?: string`, `user?: string`, `description?: string`, `ipaddress?: string` |
| `system_get_admin_details` | read | `GetAdminDetails` | *(none)* — returns the API-role admin identity/permissions (redacted) |
| `system_get_todo_items` | read | `GetToDoItems` | `status?: string`, `limitstart?: int`, `limitnum?: int` |
| `system_get_email_templates` | read | `GetEmailTemplates` | `type?: enum(general, product, domain, invoice, support, affiliate)`, `language?: string` |
| `system_send_email` | write, confirm | `SendEmail` | `messagename?: string` \| (`customtype: string`, `customsubject: string`, `custommessage: string`), `id: int` (related entity), `customvars?: record<string,string>`, `dryRun?: bool` |
| `system_get_payment_methods` | read | `GetPaymentMethods` | *(none)* |
| `system_get_currencies` | read | `GetCurrencies` | *(none)* |
| `system_log_activity` | write | `LogActivity` | `description: string`, `clientid?: int` |
| `whmcs_raw_call` | full mode only, confirm | *(any documented action)* | `action: string` (validated against a bundled allowlist of documented 8.x/9.x action names), `params: record<string, string \| number \| boolean>` — escape hatch for actions without a typed tool |

## tickets — `src/tools/tickets.ts`

| Tool | Tier | WHMCS Action | Parameters |
|---|---|---|---|
| `tickets_list` | read | `GetTickets` | `limitstart?: int`, `limitnum?: int (<=250)`, `deptid?: int`, `clientid?: int`, `email?: string`, `status?: string` (incl. `Awaiting Reply`, `All Active Tickets`, `My Flagged Tickets`), `subject?: string`, `ignore_dept_assignments?: bool` |
| `tickets_get` | read | `GetTicket` | `ticketnum?: string` \| `ticketid?: int` (one required), `repliessort?: enum(ASC, DESC)` |
| `tickets_create` | write | `OpenTicket` | `deptid: int`, `subject: string`, `message: string`, `clientid?: int` \| `contactid?: int` \| (`name: string`, `email: string`), `priority?: enum(Low, Medium, High)`, `serviceid?: int`, `domainid?: int`, `admin?: bool`, `markdown?: bool`, `customfields?: base64-encoded map`, `dryRun?: bool` |
| `tickets_reply` | write | `AddTicketReply` | `ticketid: int`, `message: string`, `adminusername?: string` \| `clientid?: int` \| `contactid?: int`, `status?: string`, `markdown?: bool`, `noemail?: bool`, `created?: datetime`, `dryRun?: bool` |
| `tickets_add_note` | write | `AddTicketNote` | `ticketid: int` \| `ticketnum: string`, `message: string`, `markdown?: bool` |
| `tickets_get_notes` | read | `GetTicketNotes` | `ticketid: int` |
| `tickets_update` | write | `UpdateTicket` | `ticketid: int`, `status?: string`, `deptid?: int`, `subject?: string`, `priority?: string`, `flag?: int` (admin id), `userid?: int`, `email?: string`, `cc?: string`, `removeFlag?: bool`, `dryRun?: bool` |
| `tickets_update_reply` | write | `UpdateTicketReply` | `replyid: int`, `message: string`, `markdown?: bool` |
| `tickets_merge` | destructive, confirm | `MergeTicket` | `ticketid: int` (target), `mergeticketids: string` (csv), `newsubject?: string` |
| `tickets_delete` | destructive, confirm | `DeleteTicket` | `ticketid: int` |
| `tickets_get_attachment` | read | `GetTicketAttachment` | `relatedid: int`, `type: enum(ticket, reply, note)`, `index: int` — returns filename + base64 (size-capped) |
| `tickets_get_counts` | read | `GetTicketCounts` | `ignoreDepartmentAssignments?: bool`, `includeCountsByStatus?: bool` |
| `tickets_get_departments` | read | `GetSupportDepartments` | `ignore_dept_assignments?: bool` |
| `tickets_get_statuses` | read | `GetSupportStatuses` | `deptid?: int` |
| `tickets_get_predefined_replies` | read | `GetTicketPredefinedReplies` | `catid?: int` |

## clients — `src/tools/clients.ts`

| Tool | Tier | WHMCS Action | Parameters |
|---|---|---|---|
| `clients_list` | read | `GetClients` | `search?: string`, `status?: enum(Active, Inactive, Closed)`, `limitstart?: int`, `limitnum?: int (<=250)`, `orderby?: string`, `sorting?: enum(ASC, DESC)` |
| `clients_get` | read | `GetClientsDetails` | `clientid?: int` \| `email?: string`, `stats?: bool` — PII redaction applied per `WHMCS_MCP_REDACT_PII` |
| `clients_create` | write | `AddClient` | `firstname: string`, `lastname: string`, `email: string`, `address1: string`, `city: string`, `state: string`, `postcode: string`, `country: string (ISO2)`, `phonenumber: string`, `companyname?: string`, `currency?: int`, `groupid?: int`, `language?: string`, `customfields?: base64 map`, `skipvalidation?: bool`, `noemail?: bool`, `dryRun?: bool` — `password2` never echoed |
| `clients_update` | write | `UpdateClient` | `clientid: int` \| `clientemail: string`, plus any of `firstname/lastname/companyname/email/address1/address2/city/state/postcode/country/phonenumber/status/notes/groupid/credit?`, `clearcreditcard?: bool`, `dryRun?: bool` |
| `clients_close` | destructive, confirm | `CloseClient` | `clientid: int` |
| `clients_get_contacts` | read | `GetContacts` | `userid?: int`, `firstname?: string`, `lastname?: string`, `email?: string`, `limitstart?: int`, `limitnum?: int` |
| `clients_add_contact` | write | `AddContact` | `clientid: int`, `firstname: string`, `lastname: string`, `email: string`, `phonenumber?: string`, `permissions?: string (csv)`, email-preference flags (`emailoninvoice?: bool`, etc.) |
| `clients_update_contact` | write | `UpdateContact` | `contactid: int`, any contact fields, `permissions?: string (csv)` |
| `clients_get_emails` | read | `GetEmails` | `clientid: int`, `date?: string`, `subject?: string`, `limitstart?: int`, `limitnum?: int` |
| `clients_get_groups` | read | `GetClientGroups` | *(none)* |
| `clients_get_services` | read | `GetClientsProducts` | `clientid?: int`, `serviceid?: int`, `pid?: int`, `domain?: string`, `username2?: string`, `limitstart?: int`, `limitnum?: int` — service passwords redacted |
| `clients_get_addons` | read | `GetClientsAddons` | `clientid?: int`, `serviceid?: int`, `addonid?: int` |

## products — `src/tools/products.ts`

| Tool | Tier | WHMCS Action | Parameters |
|---|---|---|---|
| `products_list` | read | `GetProducts` | `pid?: int \| csv`, `gid?: int`, `module?: string` |
| `products_get_promotions` | read | `GetPromotions` | `code?: string` |
| `services_update` | write | `UpdateClientProduct` | `serviceid: int`, `pid?: int`, `status?: string`, `nextduedate?: date`, `billingcycle?: string`, `recurringamount?: decimal`, `domain?: string`, `notes?: string`, `customfields?: base64 map`, `configoptions?: record`, `dryRun?: bool` |
| `services_update_addon` | write | `UpdateClientAddon` | `id: int`, `status?: string`, `addonid?: int`, `name?: string`, `setupfee?: decimal`, `recurring?: decimal`, `billingcycle?: string`, `nextduedate?: date`, `notes?: string` |
| `services_upgrade` | billing, confirm | `UpgradeProduct` | `serviceid: int`, `type: enum(product, configoptions)`, `newproductid?: int`, `newproductbillingcycle?: string`, `configoptions?: record`, `paymentmethod: string`, `promocode?: string`, `calconly?: bool` (preview path uses `calconly=true`) |
| `services_module_create` | write, confirm | `ModuleCreate` | `serviceid: int` |
| `services_module_suspend` | write, confirm | `ModuleSuspend` | `serviceid: int`, `suspendreason?: string` |
| `services_module_unsuspend` | write, confirm | `ModuleUnsuspend` | `serviceid: int` |
| `services_module_terminate` | destructive, confirm | `ModuleTerminate` | `serviceid: int` |
| `services_module_change_package` | write, confirm | `ModuleChangePackage` | `serviceid: int` |

## invoices — `src/tools/invoices.ts`

| Tool | Tier | WHMCS Action | Parameters |
|---|---|---|---|
| `billing_list_invoices` | read | `GetInvoices` | `userid?: int`, `status?: enum(Draft, Unpaid, Paid, Cancelled, Refunded, Collections, Overdue, Payment Pending)`, `limitstart?: int`, `limitnum?: int (<=250)`, `orderby?: string`, `order?: string` |
| `billing_get_invoice` | read | `GetInvoice` | `invoiceid: int` — returns items, transactions, balance |
| `billing_create_invoice` | billing, confirm; **off unless `WHMCS_MCP_MODE=full`** | `CreateInvoice` | `userid: int`, `status?: enum(Draft, Unpaid)`, `draft?: bool`, `sendinvoice?: bool`, `paymentmethod?: string`, `taxrate?: decimal`, `date?: date`, `duedate?: date`, `notes?: string`, `items: [{description: string, amount: decimal, taxed?: bool}]` (serialized to `itemdescriptionN`/`itemamountN`/`itemtaxedN`) |
| `billing_update_invoice` | billing, confirm; **off unless `WHMCS_MCP_MODE=full`** | `UpdateInvoice` | `invoiceid: int`, `status?: string`, `paymentmethod?: string`, `date?: date`, `duedate?: date`, `datepaid?: date`, `notes?: string`, `itemdescription/itemamount/itemtaxed` maps?, `newitems?: array`, `deletelineids?: int[]`, `publish?: bool`, `publishandsendemail?: bool` |
| `billing_add_payment` | billing, confirm; **off unless `WHMCS_MCP_MODE=full`** | `AddInvoicePayment` | `invoiceid: int`, `transid: string`, `gateway: string`, `amount?: decimal`, `fees?: decimal`, `date?: date`, `noemail?: bool` |
| `billing_apply_credit` | billing, confirm; **off unless `WHMCS_MCP_MODE=full`** | `ApplyCredit` | `invoiceid: int`, `amount: decimal \| 'full'`, `noemail?: bool` |
| `billing_capture_payment` | billing, confirm; **off unless `WHMCS_MCP_MODE=full`** | `CapturePayment` | `invoiceid: int`, `cvv?: string` (never logged) |
| `billing_add_credit` | billing, confirm | `AddCredit` | `clientid: int`, `description: string`, `amount: decimal`, `date?: date`, `adminid?: int`, `type?: enum(add, remove)` |
| `billing_get_credits` | read | `GetCredits` | `clientid: int` |
| `billing_get_transactions` | read | `GetTransactions` | `invoiceid?: int`, `clientid?: int`, `transid?: string` |
| `billing_add_billable_item` | billing, confirm | `AddBillableItem` | `clientid: int`, `description: string`, `amount: decimal`, `invoiceaction?: enum(noinvoice, nextcron, nextinvoice, duedate, recur)`, `recur?: int`, `recurcycle?: string`, `recurfor?: int`, `duedate?: date`, `hours?: decimal` |
| `billing_get_pay_methods` | read | `GetPayMethods` | `clientid: int`, `paymethodid?: int`, `type?: enum(BankAccount, CreditCard)` — card/bank numbers masked, never raw |
| `quotes_list` | read | `GetQuotes` | `quoteid?: int`, `userid?: int`, `subject?: string`, `stage?: string`, `datecreated?: date`, `lastmodified?: date`, `validuntil?: date`, `limitstart?: int`, `limitnum?: int` |
| `quotes_create` | billing, confirm | `CreateQuote` | `subject: string`, `stage: enum(Draft, Delivered, On Hold, Accepted, Lost, Dead)`, `validuntil: date`, `userid?: int` \| prospect fields, `lineitems: [{desc: string, qty: int, up: decimal, discount?: decimal, taxable?: bool}]`, `proposal?: string`, `customernotes?: string`, `adminnotes?: string` |
| `quotes_update` | billing, confirm | `UpdateQuote` | `quoteid: int`, any `CreateQuote` fields |
| `quotes_send` | write, confirm | `SendQuote` | `quoteid: int` |

## domains — `src/tools/domains.ts`

| Tool | Tier | WHMCS Action | Parameters |
|---|---|---|---|
| `domains_list` | read | `GetClientsDomains` | `clientid?: int`, `domainid?: int`, `domain?: string`, `limitstart?: int`, `limitnum?: int` |
| `domains_whois_availability` | read | `DomainWhois` | `domain: string` |
| `domains_get_nameservers` | read | `DomainGetNameservers` | `domainid: int` |
| `domains_update_nameservers` | write, confirm | `DomainUpdateNameservers` | `domainid: int` \| `domain: string`, `ns1: string`, `ns2: string`, `ns3?: string`, `ns4?: string`, `ns5?: string` |
| `domains_get_locking_status` | read | `DomainGetLockingStatus` | `domainid: int` |
| `domains_update_locking_status` | write, confirm | `DomainUpdateLockingStatus` | `domainid: int`, `lockstatus: bool` |
| `domains_get_whois_info` | read | `DomainGetWhoisInfo` | `domainid: int` — registrant PII redaction applies |
| `domains_update` | write | `UpdateClientDomain` | `domainid: int`, `status?: string`, `nextduedate?: date`, `expirydate?: date`, `regperiod?: int`, `recurringamount?: decimal`, `autorecalc?: bool`, `dnsmanagement?: bool`, `emailforwarding?: bool`, `idprotection?: bool`, `donotrenew?: bool`, `notes?: string` |
| `domains_renew` | billing, confirm | `DomainRenew` | `domainid: int` \| `domain: string`, `regperiod?: int` |
| `domains_register` | billing, confirm | `DomainRegister` | `domainid: int` \| `domain: string`, `idnlanguage?: string` |
| `domains_transfer` | billing, confirm | `DomainTransfer` | `domainid: int` \| `domain: string`, `eppcode?: string` (never logged) |
| `domains_get_tld_pricing` | read | `GetTLDPricing` | `currencyid?: int`, `clientid?: int` |

## orders — `src/tools/orders.ts`

| Tool | Tier | WHMCS Action | Parameters |
|---|---|---|---|
| `orders_list` | read | `GetOrders` | `id?: int`, `userid?: int`, `requestor_id?: int`, `status?: enum(Pending, Active, Fraud, Cancelled)`, `limitstart?: int`, `limitnum?: int` |
| `orders_get_statuses` | read | `GetOrderStatuses` | *(none)* |
| `orders_create` | billing, confirm | `AddOrder` | `clientid: int`, `paymentmethod: string`, `items: [{pid: int, billingcycle?: string, domain?: string, configoptions?: record, customfields?: record, priceoverride?: decimal, addons?: int[]}]`, `domains?: [{domain: string, domaintype: string, regperiod: int, eppcode?: string}]`, `promocode?: string`, `noinvoice?: bool`, `noinvoiceemail?: bool`, `noemail?: bool` (serialized to `pid[]`/`billingcycle[]` arrays) |
| `orders_accept` | write, confirm | `AcceptOrder` | `orderid: int`, `serverid?: int`, `serviceusername?: string`, `servicepassword?: string` (never echoed), `registrar?: string`, `sendregistrar?: bool`, `autosetup?: bool`, `sendemail?: bool` |
| `orders_pending` | write | `PendingOrder` | `orderid: int` |
| `orders_cancel` | destructive, confirm | `CancelOrder` | `orderid: int`, `cancelsub?: bool`, `noemail?: bool` |
| `orders_mark_fraud` | destructive, confirm | `FraudOrder` | `orderid: int`, `cancelsub?: bool` |
| `orders_delete` | destructive, confirm | `DeleteOrder` | `orderid: int` — WHMCS only allows this on `Cancelled`/`Fraud` orders |

---

## Notes

- Every `read` tool carries the MCP annotation `readOnlyHint: true`.
- Every `destructive` tool carries `destructiveHint: true` and requires a prior preview call to
  obtain a `confirmToken` (5-minute TTL, single use, HMAC-bound to tool name + argument hash — see
  `src/safety/confirm.ts`).
- `dryRun: true` on any `write`/`billing` tool short-circuits before the WHMCS API call and returns
  the request that *would* have been sent, with secrets redacted.
- Redaction (`src/safety/redact.ts`) is applied to every tool result and every error message before
  it reaches the model — it strips API secrets, passwords, card/bank numbers, CVV, EPP codes, and
  optionally email/phone/address fields per `WHMCS_MCP_REDACT_PII`.
- Compatibility: the action names and parameter shapes above are unchanged across WHMCS 8.12.x and
  9.0.x for every tool. `system_get_details` (`WhmcsDetails`) is called at startup to confirm the
  live version; see `docs/version-compatibility.md`.
