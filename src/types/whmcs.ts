/**
 * TypeScript response types for the WHMCS External API.
 *
 * Source: developers.whmcs.com/api-reference/ (parameter/response tables per
 * action). Verified compatible with the 8.12.x and 9.0.x contract; the exact
 * shape is confirmed at runtime via `system_get_details` (WhmcsDetails).
 *
 * WHMCS's raw JSON responses nest repeating collections under a wrapper key,
 * e.g. `{ tickets: { ticket: RawTicket[] } }` or a single-item object instead
 * of an array when there is exactly one result. `src/whmcs-client.ts` is
 * responsible for normalizing those into plain arrays; the `*Raw` type
 * aliases below document the wire shape before normalization, and the
 * unprefixed types document the normalized shape tools should return.
 *
 * All numeric-looking fields WHMCS returns as strings (ids, amounts, dates)
 * are typed as `string` here to match the wire format; callers coerce as
 * needed. Fields that are consistently redacted/never populated by design
 * (passwords, secrets, card numbers) are typed but flagged with a comment;
 * `src/safety/redact.ts` strips or masks them before a tool result reaches
 * the model.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** WHMCS renders most ids as numeric strings in API responses. */
export type WhmcsId = number | string;

/** WHMCS date format is typically `YYYY-MM-DD`. */
export type WhmcsDate = string;

/** WHMCS datetime format is typically `YYYY-MM-DD HH:MM:SS`. */
export type WhmcsDateTime = string;

/** Decimal money amounts are returned as strings, e.g. "10.00". */
export type WhmcsMoney = string;

/** Generic result envelope every WHMCS API action returns. */
export interface WhmcsResultBase {
  result: "success" | "error";
  /** Present when result === "error". */
  message?: string;
}

/** A raw WHMCS "maybe array, maybe single object" collection wrapper. */
export type WhmcsCollection<TKey extends string, TItem> = Partial<Record<TKey, TItem[] | TItem>>;

// ---------------------------------------------------------------------------
// System / WhmcsDetails (system_get_details, system_get_*)
// ---------------------------------------------------------------------------

/** Response of the `WhmcsDetails` action (tool: system_get_details). */
export interface WhmcsDetails extends WhmcsResultBase {
  whmcs: {
    version: string;
    /** e.g. "Release" | "Beta" */
    release_status?: string;
    /** International/localization edition indicator, when present. */
    edition?: string;
  };
}

export interface WhmcsStatsResponse extends WhmcsResultBase {
  income_alltime?: WhmcsMoney;
  income_thismonth?: WhmcsMoney;
  income_thisyear?: WhmcsMoney;
  income_today?: WhmcsMoney;
  num_orders_alltime?: string;
  num_orders_thismonth?: string;
  num_orders_thisyear?: string;
  num_orders_today?: string;
  num_clients?: string;
  num_clients_active?: string;
  num_tickets_open?: string;
  [key: string]: unknown;
}

export interface WhmcsActivityLogEntryRaw {
  id: WhmcsId;
  date: WhmcsDateTime;
  description: string;
  user?: string;
  ipaddress?: string;
}
export type WhmcsActivityLogRaw = WhmcsResultBase &
  WhmcsCollection<"activity", WhmcsActivityLogEntryRaw> & { totalresults?: string };
export type WhmcsActivityLogEntry = WhmcsActivityLogEntryRaw;

/** Response of `GetAdminDetails`. Sensitive fields are redacted before return. */
export interface WhmcsAdminDetails extends WhmcsResultBase {
  adminid: WhmcsId;
  username: string;
  firstname?: string;
  lastname?: string;
  email?: string;
  /** Never populated by src/safety/redact.ts. */
  password?: undefined;
  roleid?: WhmcsId;
  rolename?: string;
  permissions?: string[];
  disabled?: "0" | "1";
}

export interface WhmcsToDoItemRaw {
  id: WhmcsId;
  date: WhmcsDate;
  duedate?: WhmcsDate;
  description: string;
  status: "Incomplete" | "Complete" | (string & {});
  admin?: string;
}
export type WhmcsToDoItemsRaw = WhmcsResultBase &
  WhmcsCollection<"items", WhmcsToDoItemRaw>;
export type WhmcsToDoItem = WhmcsToDoItemRaw;

export interface WhmcsEmailTemplateRaw {
  id: WhmcsId;
  name: string;
  type: string;
  subject?: string;
  language?: string;
  disabled?: "0" | "1";
  message?: string;
  plaintext?: string;
}
export type WhmcsEmailTemplatesRaw = WhmcsResultBase &
  WhmcsCollection<"emailtemplate", WhmcsEmailTemplateRaw>;
export type WhmcsEmailTemplate = WhmcsEmailTemplateRaw;

export interface WhmcsPaymentMethodRaw {
  module: string;
  displayname: string;
}
export type WhmcsPaymentMethodsRaw = WhmcsResultBase &
  WhmcsCollection<"paymentmethod", WhmcsPaymentMethodRaw>;
export type WhmcsPaymentMethod = WhmcsPaymentMethodRaw;

export interface WhmcsCurrencyRaw {
  id: WhmcsId;
  code: string;
  prefix?: string;
  suffix?: string;
  format?: string;
  rate?: string;
  default?: "0" | "1";
}
export type WhmcsCurrenciesRaw = WhmcsResultBase &
  WhmcsCollection<"currency", WhmcsCurrencyRaw>;
export type WhmcsCurrency = WhmcsCurrencyRaw;

// ---------------------------------------------------------------------------
// Tickets (GetTickets, GetTicket, OpenTicket, AddTicketReply, ...)
// ---------------------------------------------------------------------------

export interface TicketReplyRaw {
  id: WhmcsId;
  replyid?: WhmcsId;
  requestorname?: string;
  requestoremail?: string;
  email?: string;
  date: WhmcsDateTime;
  message: string;
  markdown?: string;
  admin?: string;
  adminusername?: string;
  attachments?: unknown;
}
export type TicketReply = TicketReplyRaw;

export interface TicketNoteRaw {
  id: WhmcsId;
  date: WhmcsDateTime;
  message: string;
  admin?: string;
  adminusername?: string;
}
export type TicketNote = TicketNoteRaw;

export interface TicketRaw {
  id: WhmcsId;
  tid?: string;
  ticketnum: string;
  deptid: WhmcsId;
  deptname?: string;
  userid?: WhmcsId;
  contactid?: WhmcsId;
  subject: string;
  message?: string;
  status: string;
  priority?: "Low" | "Medium" | "High" | (string & {});
  admin?: string;
  name?: string;
  email?: string;
  cc?: string;
  date: WhmcsDateTime;
  lastreply?: WhmcsDateTime;
  flag?: WhmcsId;
  service?: string;
  serviceid?: WhmcsId;
  domain?: string;
  domainid?: WhmcsId;
  attachments?: unknown;
  replies?: WhmcsCollection<"reply", TicketReplyRaw>;
  notes?: WhmcsCollection<"note", TicketNoteRaw>;
}

/** Normalized ticket shape returned by tickets_get / tickets_list. */
export interface Ticket
  extends Omit<TicketRaw, "replies" | "notes"> {
  replies?: TicketReply[];
  notes?: TicketNote[];
}

export type WhmcsGetTicketsRaw = WhmcsResultBase &
  WhmcsCollection<"ticket", TicketRaw> & {
    totalresults?: string;
    startnumber?: string;
    numreturned?: string;
  };

export type WhmcsGetTicketRaw = WhmcsResultBase & TicketRaw;

export interface WhmcsOpenTicketResult extends WhmcsResultBase {
  ticketid: WhmcsId;
  tid?: string;
}

export type WhmcsAddTicketReplyResult = WhmcsResultBase;

export interface WhmcsTicketCountsResult extends WhmcsResultBase {
  awaitingreply?: string;
  answered?: string;
  customerreply?: string;
  closed?: string;
  onhold?: string;
  inprogress?: string;
  total?: string;
  bystatus?: Record<string, string>;
}

export interface WhmcsSupportDepartmentRaw {
  id: WhmcsId;
  name: string;
  awaitingreplycount?: string;
}
export type WhmcsSupportDepartmentsRaw = WhmcsResultBase &
  WhmcsCollection<"department", WhmcsSupportDepartmentRaw>;
export type WhmcsSupportDepartment = WhmcsSupportDepartmentRaw;

export interface WhmcsSupportStatusRaw {
  title: string;
  color?: string;
}
export type WhmcsSupportStatusesRaw = WhmcsResultBase &
  WhmcsCollection<"status", WhmcsSupportStatusRaw>;
export type WhmcsSupportStatus = WhmcsSupportStatusRaw;

export interface WhmcsPredefinedReplyRaw {
  id: WhmcsId;
  catid?: WhmcsId;
  name: string;
  message: string;
}
export type WhmcsPredefinedRepliesRaw = WhmcsResultBase &
  WhmcsCollection<"predefinedreply", WhmcsPredefinedReplyRaw>;
export type WhmcsPredefinedReply = WhmcsPredefinedReplyRaw;

export interface WhmcsTicketAttachmentResult extends WhmcsResultBase {
  filename: string;
  /** Base64-encoded content; size-capped by the tool layer before return. */
  data: string;
}

// ---------------------------------------------------------------------------
// Clients / Contacts (GetClients, GetClientsDetails, AddClient, ...)
// ---------------------------------------------------------------------------

export interface ClientRaw {
  id: WhmcsId;
  userid?: WhmcsId;
  firstname: string;
  lastname: string;
  companyname?: string;
  email: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  phonenumber?: string;
  status?: "Active" | "Inactive" | "Closed" | (string & {});
  groupid?: WhmcsId;
  currency?: WhmcsId;
  defaultgateway?: string;
  datecreated?: WhmcsDate;
  notes?: string;
  /** Never populated by src/safety/redact.ts. */
  password?: undefined;
  credit?: WhmcsMoney;
  stats?: {
    numproducts?: string;
    numorders?: string;
    numdomains?: string;
    numtickets?: string;
    numinvoices?: string;
    numinvoicesoverdue?: string;
    numinvoicesunpaid?: string;
  };
}

/** Normalized client returned by clients_get / clients_list. */
export type Client = ClientRaw;

export type WhmcsGetClientsRaw = WhmcsResultBase &
  WhmcsCollection<"client", ClientRaw> & {
    totalresults?: string;
    startnumber?: string;
    numreturned?: string;
  };

export type WhmcsGetClientsDetailsRaw = WhmcsResultBase & ClientRaw;

export interface WhmcsAddClientResult extends WhmcsResultBase {
  clientid: WhmcsId;
}

export interface WhmcsUpdateClientResult extends WhmcsResultBase {
  clientid: WhmcsId;
}

export interface ContactRaw {
  id: WhmcsId;
  userid: WhmcsId;
  firstname: string;
  lastname: string;
  companyname?: string;
  email: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  phonenumber?: string;
  permissions?: string[] | string;
  emailoptout?: "0" | "1";
}
export type Contact = ContactRaw;
export type WhmcsGetContactsRaw = WhmcsResultBase &
  WhmcsCollection<"contact", ContactRaw>;

export interface WhmcsAddContactResult extends WhmcsResultBase {
  contactid: WhmcsId;
}

export interface WhmcsClientEmailRaw {
  id: WhmcsId;
  date: WhmcsDateTime;
  subject: string;
  to?: string;
}
export type WhmcsGetEmailsRaw = WhmcsResultBase &
  WhmcsCollection<"email", WhmcsClientEmailRaw>;
export type WhmcsClientEmail = WhmcsClientEmailRaw;

export interface WhmcsClientGroupRaw {
  id: WhmcsId;
  name: string;
}
export type WhmcsClientGroupsRaw = WhmcsResultBase &
  WhmcsCollection<"group", WhmcsClientGroupRaw>;
export type WhmcsClientGroup = WhmcsClientGroupRaw;

// ---------------------------------------------------------------------------
// Products / Services / Addons
// ---------------------------------------------------------------------------

export interface ConfigOptionRaw {
  option_name?: string;
  option_id?: WhmcsId;
  qty?: string;
  value?: string;
}

export interface ServiceRaw {
  id: WhmcsId;
  pid: WhmcsId;
  userid?: WhmcsId;
  orderid?: WhmcsId;
  regdate?: WhmcsDate;
  domain?: string;
  domainstatus?: string;
  firstpaymentamount?: WhmcsMoney;
  recurringamount?: WhmcsMoney;
  billingcycle?: string;
  nextduedate?: WhmcsDate;
  status?: string;
  username?: string;
  /** Never populated by src/safety/redact.ts. */
  password?: undefined;
  name?: string;
  groupname?: string;
  dedicatedip?: string;
  server?: string;
  serverip?: string;
  serverhostname?: string;
  ns1?: string;
  ns2?: string;
  assignedips?: string;
  notes?: string;
  diskusage?: string;
  disklimit?: string;
  bwusage?: string;
  bwlimit?: string;
  lastupdate?: WhmcsDateTime;
  suspendreason?: string;
  configoptions?: ConfigOptionRaw[];
  customfields?: Record<string, string>;
}
export type Service = ServiceRaw;
export type WhmcsGetClientsProductsRaw = WhmcsResultBase &
  WhmcsCollection<"product", ServiceRaw> & { totalresults?: string };

export interface AddonRaw {
  id: WhmcsId;
  addonid: WhmcsId;
  serviceid?: WhmcsId;
  name: string;
  status?: string;
  setupfee?: WhmcsMoney;
  recurring?: WhmcsMoney;
  billingcycle?: string;
  nextduedate?: WhmcsDate;
  notes?: string;
}
export type Addon = AddonRaw;
export type WhmcsGetClientsAddonsRaw = WhmcsResultBase &
  WhmcsCollection<"addon", AddonRaw>;

export interface ProductRaw {
  pid: WhmcsId;
  gid?: WhmcsId;
  type?: string;
  name: string;
  productname?: string;
  description?: string;
  module?: string;
  paytype?: "free" | "onetime" | "recurring" | (string & {});
  pricing?: Record<
    string,
    { prefix?: string; suffix?: string; msetupfee?: string; qsetupfee?: string; [cycle: string]: unknown }
  >;
}
export type Product = ProductRaw;
export type WhmcsGetProductsRaw = WhmcsResultBase &
  WhmcsCollection<"product", ProductRaw>;

export interface WhmcsPromotionRaw {
  id: WhmcsId;
  code: string;
  type?: string;
  value?: string;
  recurring?: string;
  appliesTo?: string;
  cycles?: string;
  startDate?: WhmcsDate;
  expiryDate?: WhmcsDate;
}
export type WhmcsGetPromotionsRaw = WhmcsResultBase &
  WhmcsCollection<"promotion", WhmcsPromotionRaw>;

export type WhmcsUpdateClientProductResult = WhmcsResultBase;
export type WhmcsUpdateClientAddonResult = WhmcsResultBase;

/** Response of `UpgradeProduct`; `calconly=true` returns a price preview only. */
export interface WhmcsUpgradeProductResult extends WhmcsResultBase {
  orderid?: WhmcsId;
  invoiceid?: WhmcsId;
  /** Present when calconly=true (dry-run/preview path). */
  price?: WhmcsMoney;
  proratadate?: WhmcsDate;
  recurringamount?: WhmcsMoney;
}

export type WhmcsModuleActionResult = WhmcsResultBase;

// ---------------------------------------------------------------------------
// Invoices / Transactions / Credits / Quotes
// ---------------------------------------------------------------------------

export interface InvoiceItemRaw {
  id?: WhmcsId;
  type?: string;
  relid?: WhmcsId;
  description: string;
  amount: WhmcsMoney;
  taxed?: "0" | "1" | boolean;
}
export type InvoiceItem = InvoiceItemRaw;

export interface TransactionRaw {
  id: WhmcsId;
  invoiceid?: WhmcsId;
  userid?: WhmcsId;
  gateway?: string;
  date?: WhmcsDateTime;
  transid?: string;
  amountin?: WhmcsMoney;
  fees?: WhmcsMoney;
  amountout?: WhmcsMoney;
  rate?: string;
  currency?: string;
}
export type Transaction = TransactionRaw;
export type WhmcsGetTransactionsRaw = WhmcsResultBase &
  WhmcsCollection<"transactions", TransactionRaw> & { numreturned?: string; totalresults?: string };

export interface InvoiceRaw {
  invoiceid: WhmcsId;
  id?: WhmcsId;
  userid: WhmcsId;
  firstname?: string;
  lastname?: string;
  companyname?: string;
  email?: string;
  invoicenum?: string;
  date: WhmcsDate;
  duedate?: WhmcsDate;
  datepaid?: WhmcsDateTime;
  subtotal?: WhmcsMoney;
  credit?: WhmcsMoney;
  tax?: WhmcsMoney;
  tax2?: WhmcsMoney;
  total: WhmcsMoney;
  balance?: WhmcsMoney;
  taxrate?: string;
  taxrate2?: string;
  status: "Draft" | "Unpaid" | "Paid" | "Cancelled" | "Refunded" | "Collections" | "Payment Pending" | (string & {});
  paymentmethod?: string;
  notes?: string;
  items?: WhmcsCollection<"item", InvoiceItemRaw>;
  transactions?: WhmcsCollection<"transaction", TransactionRaw>;
}

/** Normalized invoice shape returned by billing_get_invoice. */
export interface Invoice
  extends Omit<InvoiceRaw, "items" | "transactions"> {
  items?: InvoiceItem[] | undefined;
  transactions?: Transaction[] | undefined;
}

export type WhmcsGetInvoicesRaw = WhmcsResultBase &
  WhmcsCollection<"invoice", InvoiceRaw> & {
    totalresults?: string;
    startnumber?: string;
    numreturned?: string;
  };
export type WhmcsGetInvoiceRaw = WhmcsResultBase & InvoiceRaw;

export interface WhmcsCreateInvoiceResult extends WhmcsResultBase {
  invoiceid: WhmcsId;
}
export type WhmcsUpdateInvoiceResult = WhmcsResultBase;
export type WhmcsAddInvoicePaymentResult = WhmcsResultBase;
export type WhmcsApplyCreditResult = WhmcsResultBase;
export interface WhmcsCapturePaymentResult extends WhmcsResultBase {
  transactionId?: string;
  amount?: WhmcsMoney;
}
export type WhmcsAddCreditResult = WhmcsResultBase;
export interface WhmcsAddBillableItemResult extends WhmcsResultBase {
  itemid?: WhmcsId;
  invoiceid?: WhmcsId;
}

export interface CreditLogRaw {
  id: WhmcsId;
  date: WhmcsDateTime;
  description: string;
  amount: WhmcsMoney;
  type?: "Add" | "Remove" | (string & {});
  admin?: string;
}
export type WhmcsGetCreditsRaw = WhmcsResultBase & {
  credit?: WhmcsMoney;
} & WhmcsCollection<"creditlog", CreditLogRaw>;

/** Payment method on file for a client; card/bank numbers are masked, never raw. */
export interface PayMethodRaw {
  id: WhmcsId;
  type: "BankAccount" | "CreditCard" | (string & {});
  description?: string;
  /** Masked, e.g. "**** **** **** 4242"; never the full PAN. */
  cardLastFour?: string;
  cardType?: string;
  expiryDate?: string;
  default?: "0" | "1";
}
export type PayMethod = PayMethodRaw;
export type WhmcsGetPayMethodsRaw = WhmcsResultBase &
  WhmcsCollection<"paymethods", PayMethodRaw>;

export interface QuoteLineItemRaw {
  description: string;
  qty?: string;
  up?: WhmcsMoney;
  discount?: WhmcsMoney;
  taxable?: "0" | "1" | boolean;
}
export type QuoteLineItem = QuoteLineItemRaw;

export interface QuoteRaw {
  id: WhmcsId;
  quoteid?: WhmcsId;
  subject: string;
  stage: "Draft" | "Delivered" | "On Hold" | "Accepted" | "Lost" | "Dead" | (string & {});
  userid?: WhmcsId;
  datecreated?: WhmcsDate;
  lastmodified?: WhmcsDate;
  validuntil?: WhmcsDate;
  proposal?: string;
  customernotes?: string;
  adminnotes?: string;
  subtotal?: WhmcsMoney;
  total?: WhmcsMoney;
  lineitems?: WhmcsCollection<"lineitem", QuoteLineItemRaw>;
}
export interface Quote extends Omit<QuoteRaw, "lineitems"> {
  lineitems?: QuoteLineItem[] | undefined;
}
export type WhmcsGetQuotesRaw = WhmcsResultBase &
  WhmcsCollection<"quotes", QuoteRaw> & { totalresults?: string };

export interface WhmcsCreateQuoteResult extends WhmcsResultBase {
  quoteid: WhmcsId;
}
export type WhmcsUpdateQuoteResult = WhmcsResultBase;
export type WhmcsSendQuoteResult = WhmcsResultBase;

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export interface DomainRaw {
  id: WhmcsId;
  domainid?: WhmcsId;
  userid?: WhmcsId;
  orderid?: WhmcsId;
  domainname?: string;
  domain?: string;
  registrar?: string;
  registrationdate?: WhmcsDate;
  expirydate?: WhmcsDate;
  nextduedate?: WhmcsDate;
  status?: string;
  regperiod?: string;
  recurringamount?: WhmcsMoney;
  donotrenew?: "0" | "1";
  dnsmanagement?: "0" | "1";
  emailforwarding?: "0" | "1";
  idprotection?: "0" | "1";
  notes?: string;
}
export type Domain = DomainRaw;
export type WhmcsGetClientsDomainsRaw = WhmcsResultBase &
  WhmcsCollection<"domain", DomainRaw> & { totalresults?: string };

export interface WhmcsDomainWhoisResult extends WhmcsResultBase {
  domain: string;
  available?: boolean;
  status?: string;
  [key: string]: unknown;
}

export interface WhmcsDomainGetNameserversResult extends WhmcsResultBase {
  ns1?: string;
  ns2?: string;
  ns3?: string;
  ns4?: string;
  ns5?: string;
}
export type WhmcsDomainUpdateNameserversResult = WhmcsResultBase;

export interface WhmcsDomainGetLockingStatusResult extends WhmcsResultBase {
  locked: boolean | "1" | "0";
}
export type WhmcsDomainUpdateLockingStatusResult = WhmcsResultBase;

/** Registrant WHOIS contact info; PII redaction applies before return. */
export interface WhmcsDomainWhoisInfoResult extends WhmcsResultBase {
  Registrant?: Record<string, string>;
  Admin?: Record<string, string>;
  Technical?: Record<string, string>;
  Billing?: Record<string, string>;
}

export type WhmcsUpdateClientDomainResult = WhmcsResultBase;
export interface WhmcsDomainRenewResult extends WhmcsResultBase {
  invoiceid?: WhmcsId;
}
export interface WhmcsDomainRegisterResult extends WhmcsResultBase {
  invoiceid?: WhmcsId;
}
export interface WhmcsDomainTransferResult extends WhmcsResultBase {
  invoiceid?: WhmcsId;
}

export interface WhmcsTldPricingEntryRaw {
  register?: Record<string, WhmcsMoney>;
  transfer?: Record<string, WhmcsMoney>;
  renew?: Record<string, WhmcsMoney>;
  grace_period?: Record<string, unknown>;
  redemption_period?: Record<string, unknown>;
}
export type WhmcsGetTLDPricingRaw = WhmcsResultBase & {
  pricing?: Record<string, WhmcsTldPricingEntryRaw>;
};

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface OrderRaw {
  id: WhmcsId;
  ordernum?: string;
  userid: WhmcsId;
  contactid?: WhmcsId;
  date: WhmcsDateTime;
  status: "Pending" | "Active" | "Fraud" | "Cancelled" | (string & {});
  paymentmethod?: string;
  amount?: WhmcsMoney;
  invoiceid?: WhmcsId;
  promocode?: string;
  notes?: string;
}
export type Order = OrderRaw;
export type WhmcsGetOrdersRaw = WhmcsResultBase &
  WhmcsCollection<"orders", OrderRaw> & { totalresults?: string };

export interface WhmcsOrderStatusRaw {
  name: string;
}
export type WhmcsGetOrderStatusesRaw = WhmcsResultBase &
  WhmcsCollection<"status", WhmcsOrderStatusRaw>;

export interface WhmcsAddOrderResult extends WhmcsResultBase {
  orderid: WhmcsId;
  invoiceid?: WhmcsId;
  productids?: WhmcsId[];
  domainids?: WhmcsId[];
  addonids?: WhmcsId[];
}
export type WhmcsAcceptOrderResult = WhmcsResultBase;
export type WhmcsPendingOrderResult = WhmcsResultBase;
export type WhmcsCancelOrderResult = WhmcsResultBase;
export type WhmcsFraudOrderResult = WhmcsResultBase;
export type WhmcsDeleteOrderResult = WhmcsResultBase;

// ---------------------------------------------------------------------------
// Misc system-level results used across tools
// ---------------------------------------------------------------------------

export type WhmcsSendEmailResult = WhmcsResultBase;
export type WhmcsLogActivityResult = WhmcsResultBase;
export type WhmcsDeleteTicketResult = WhmcsResultBase;
export type WhmcsMergeTicketResult = WhmcsResultBase;
export type WhmcsCloseClientResult = WhmcsResultBase;

/**
 * Generic escape-hatch response for `whmcs_raw_call`. The action name is
 * validated against a bundled allowlist of documented 8.x/9.x actions before
 * the request is sent; the response shape is action-dependent and therefore
 * left as an unknown record for the caller to interpret.
 */
export type WhmcsRawCallResult = WhmcsResultBase & Record<string, unknown>;
