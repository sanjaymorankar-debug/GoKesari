/**
 * RBAC v2 generic approval engine (docs/rbac; drizzle/0170_rbac_v2_foundation.sql).
 *
 *   approval_requests       one request of any type (four-eye admin action, journal entry,
 *                           rate change, shop-owner change request …), who asked, who checks
 *   approval_request_items  the line items: one field of one entity, old → proposed → applied
 *   approval_decisions      every submit / approve / reject / apply, append-only (DB trigger)
 *
 * Users and shops are not referenced by foreign key (the service checks those links).
 * Re-exported by schema.ts.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, customType, date, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const APPROVAL_STATUSES = [
  "PENDING",
  "APPROVED",
  "PARTIALLY_APPROVED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "SUPERSEDED",
  "FAILED",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Who decides. CA_THEN_ADMIN: stage 1 the CA approves, stage 2 an admin activates. */
export const APPROVAL_CHECKERS = ["ADMIN", "CA", "SHOP_OWNER", "CA_THEN_ADMIN"] as const;
export type ApprovalChecker = (typeof APPROVAL_CHECKERS)[number];

export const APPROVAL_ITEM_STATUSES = ["PENDING", "APPROVED", "REJECTED", "SUPERSEDED", "EXPIRED", "CANCELLED"] as const;
export type ApprovalItemStatus = (typeof APPROVAL_ITEM_STATUSES)[number];

export const APPROVAL_ACTIONS = [
  "SUBMIT",
  "APPROVE",
  "REJECT",
  "CANCEL",
  "EXPIRE",
  "SUPERSEDE",
  "APPLY",
  "APPLY_FAILED",
  "REMIND",
  "CONFIRM",
] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Handler key, e.g. USER_ROLE_SET, USER_SUSPEND_CONFIRM, FEATURE_FLAG_SET. */
    type: text("type").notNull(),
    status: text("status", { enum: APPROVAL_STATUSES }).notNull().default("PENDING"),
    checker: text("checker", { enum: APPROVAL_CHECKERS }).notNull(),
    stage: integer("stage").notNull().default(1),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id"),
    shopId: uuid("shop_id"),
    title: text("title").notNull(),
    reason: text("reason").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    requestedBy: uuid("requested_by").notNull(),
    requestedByRole: text("requested_by_role").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionComment: text("decision_comment"),
    /** Approved by the Super Admin alone while fewer than two admins were active (bootstrap rule). */
    singleAdmin: boolean("single_admin").notNull().default(false),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Emergency actions already applied: a second admin must confirm by this time. */
    confirmBy: timestamp("confirm_by", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    applyError: text("apply_error"),
    linkedTicketId: uuid("linked_ticket_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("approval_requests_status_idx").on(t.status, t.checker, t.requestedAt),
    index("approval_requests_subject_idx").on(t.subjectType, t.subjectId),
  ],
);
export type ApprovalRequest = typeof approvalRequests.$inferSelect;

export const approvalRequestItems = pgTable(
  "approval_request_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => approvalRequests.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    field: text("field").notNull(),
    previousValue: jsonb("previous_value").$type<unknown>(),
    proposedValue: jsonb("proposed_value").$type<unknown>(),
    finalValue: jsonb("final_value").$type<unknown>(),
    status: text("status", { enum: APPROVAL_ITEM_STATUSES }).notNull().default("PENDING"),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    rejectionComment: text("rejection_comment"),
  },
  (t) => [index("approval_request_items_request_idx").on(t.requestId, t.position)],
);
export type ApprovalRequestItem = typeof approvalRequestItems.$inferSelect;

/** Append-only (trigger approval_decisions_append_only). */
export const approvalDecisions = pgTable(
  "approval_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => approvalRequests.id, { onDelete: "cascade" }),
    itemId: uuid("item_id"),
    action: text("action", { enum: APPROVAL_ACTIONS }).notNull(),
    actorId: uuid("actor_id"),
    actorRole: text("actor_role"),
    comment: text("comment"),
    singleAdmin: boolean("single_admin").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("approval_decisions_request_idx").on(t.requestId, t.createdAt)],
);
export type ApprovalDecision = typeof approvalDecisions.$inferSelect;

/* ======================================================== Phase 3: accounting (0171) */

export const finPeriods = pgTable("fin_periods", {
  /** YYYY-MM. */
  code: text("code").primaryKey(),
  startsOn: date("starts_on", { mode: "string" }).notNull(),
  endsOn: date("ends_on", { mode: "string" }).notNull(),
  status: text("status", { enum: ["OPEN", "CLOSED"] }).notNull().default("OPEN"),
  closedBy: uuid("closed_by"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  reopenedBy: uuid("reopened_by"),
  reopenedAt: timestamp("reopened_at", { withTimezone: true }),
  note: text("note"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type FinPeriod = typeof finPeriods.$inferSelect;

export const JOURNAL_STATUSES = ["DRAFT", "SUBMITTED", "POSTED", "REJECTED", "REVERSED"] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

/** A POSTED entry is never edited (DB trigger fin_journal_entries_guard); it is corrected by a reversing entry. */
export const finJournalEntries = pgTable(
  "fin_journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryNumber: text("entry_number").notNull().default(sql`('JE-' || lpad(nextval('fin_journal_entry_number_seq')::text, 6, '0'))`),
    entryDate: date("entry_date", { mode: "string" }).notNull(),
    periodCode: text("period_code").notNull(),
    narration: text("narration").notNull(),
    status: text("status", { enum: JOURNAL_STATUSES }).notNull().default("DRAFT"),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull().default(0),
    preparedBy: uuid("prepared_by").notNull(),
    approvalRequestId: uuid("approval_request_id"),
    postedBy: uuid("posted_by"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    reversesEntryId: uuid("reverses_entry_id"),
    reversedByEntryId: uuid("reversed_by_entry_id"),
    rejectionComment: text("rejection_comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("fin_journal_entries_period_idx").on(t.periodCode, t.status)],
);
export type FinJournalEntry = typeof finJournalEntries.$inferSelect;

export const finJournalLines = pgTable(
  "fin_journal_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => finJournalEntries.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    accountCode: text("account_code").notNull(),
    accountName: text("account_name").notNull(),
    debitPaise: bigint("debit_paise", { mode: "number" }).notNull().default(0),
    creditPaise: bigint("credit_paise", { mode: "number" }).notNull().default(0),
    memo: text("memo"),
  },
  (t) => [index("fin_journal_lines_entry_idx").on(t.entryId, t.position)],
);
export type FinJournalLine = typeof finJournalLines.$inferSelect;

export const RATE_KINDS = ["COMMISSION", "REGISTRATION_FEE", "DELIVERY_CHARGE"] as const;
export type RateKind = (typeof RATE_KINDS)[number];
export const RATE_PROPOSAL_STATUSES = ["PENDING_CA", "PENDING_ADMIN", "SCHEDULED", "ACTIVATED", "REJECTED", "CANCELLED", "FAILED"] as const;

export const rateChangeProposals = pgTable(
  "rate_change_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rateKind: text("rate_kind", { enum: RATE_KINDS }).notNull(),
    /** COMMISSION: DEFAULT | SHOP_TYPE | SHOP. */
    scope: text("scope"),
    /** The shop type or shop id for a scoped commission. */
    scopeKey: text("scope_key"),
    currentValue: jsonb("current_value").$type<unknown>(),
    proposedValue: jsonb("proposed_value").$type<Record<string, unknown>>().notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    status: text("status", { enum: RATE_PROPOSAL_STATUSES }).notNull().default("PENDING_CA"),
    approvalRequestId: uuid("approval_request_id"),
    proposedBy: uuid("proposed_by").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    applyError: text("apply_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rate_change_proposals_status_idx").on(t.status, t.effectiveAt)],
);
export type RateChangeProposal = typeof rateChangeProposals.$inferSelect;

/* ============================================= Phase 3 follow-up: bank reconciliation (0175) */

export const BANK_STATEMENT_STATUSES = ["OPEN", "SUBMITTED", "RECONCILED"] as const;
export type BankStatementStatus = (typeof BANK_STATEMENT_STATUSES)[number];
export const BANK_LINE_STATUSES = ["UNMATCHED", "MATCHED", "EXCLUDED"] as const;
export type BankLineStatus = (typeof BANK_LINE_STATUSES)[number];
/** What a bank line can be matched to (each an existing record, only read). */
export const BANK_MATCH_KINDS = ["SHOP_PAYOUT", "SHOP_SETTLEMENT", "RIDER_PAYOUT", "RIDER_TRANSFER", "DEALER_PAYOUT", "BANK_REFUND", "JOURNAL"] as const;
export type BankMatchKind = (typeof BANK_MATCH_KINDS)[number];

export interface BankLineSuggestion {
  kind: BankMatchKind;
  id: string;
  label: string;
  amountPaise: number;
  why: string;
}

/** A RECONCILED statement is final (DB trigger fin_bank_statements_guard); lines change only while OPEN. */
export const finBankStatements = pgTable(
  "fin_bank_statements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    statementNumber: text("statement_number").notNull().default(sql`('BS-' || lpad(nextval('fin_bank_statement_number_seq')::text, 6, '0'))`),
    /** The bank account as people know it, e.g. "HDFC current ••1234" (never the full account number). */
    accountLabel: text("account_label").notNull(),
    periodFrom: date("period_from", { mode: "string" }).notNull(),
    periodTo: date("period_to", { mode: "string" }).notNull(),
    openingBalancePaise: bigint("opening_balance_paise", { mode: "number" }),
    closingBalancePaise: bigint("closing_balance_paise", { mode: "number" }),
    totalDebitPaise: bigint("total_debit_paise", { mode: "number" }).notNull().default(0),
    totalCreditPaise: bigint("total_credit_paise", { mode: "number" }).notNull().default(0),
    lineCount: integer("line_count").notNull().default(0),
    fileName: text("file_name").notNull(),
    fileSha256: text("file_sha256").notNull(),
    warnings: jsonb("warnings").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: text("status", { enum: BANK_STATEMENT_STATUSES }).notNull().default("OPEN"),
    uploadedBy: uuid("uploaded_by").notNull(),
    approvalRequestId: uuid("approval_request_id"),
    signedOffBy: uuid("signed_off_by"),
    signedOffAt: timestamp("signed_off_at", { withTimezone: true }),
    rejectionComment: text("rejection_comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("fin_bank_statements_account_idx").on(t.accountLabel, t.periodFrom)],
);
export type FinBankStatement = typeof finBankStatements.$inferSelect;

export const finBankStatementLines = pgTable(
  "fin_bank_statement_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    statementId: uuid("statement_id")
      .notNull()
      .references(() => finBankStatements.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    txnDate: date("txn_date", { mode: "string" }).notNull(),
    valueDate: date("value_date", { mode: "string" }),
    description: text("description").notNull().default(""),
    reference: text("reference"),
    debitPaise: bigint("debit_paise", { mode: "number" }).notNull().default(0),
    creditPaise: bigint("credit_paise", { mode: "number" }).notNull().default(0),
    balancePaise: bigint("balance_paise", { mode: "number" }),
    status: text("status", { enum: BANK_LINE_STATUSES }).notNull().default("UNMATCHED"),
    matchKind: text("match_kind", { enum: BANK_MATCH_KINDS }),
    matchId: uuid("match_id"),
    matchMethod: text("match_method", { enum: ["AUTO", "MANUAL"] }),
    matchedBy: uuid("matched_by"),
    matchedAt: timestamp("matched_at", { withTimezone: true }),
    note: text("note"),
    suggestion: jsonb("suggestion").$type<BankLineSuggestion | null>(),
  },
  (t) => [index("fin_bank_statement_lines_status_idx").on(t.statementId, t.status)],
);
export type FinBankStatementLine = typeof finBankStatementLines.$inferSelect;

/* ============================================ Phases 4–5: teams, shop MRP history (0172) */

export const STAFF_TEAMS = ["SUPPORT", "OPERATIONS"] as const;
export type StaffTeam = (typeof STAFF_TEAMS)[number];

/** Which manager a Support / Operations staff member reports to (one active team row per member and team). */
export const staffTeamMembers = pgTable(
  "staff_team_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    team: text("team", { enum: STAFF_TEAMS }).notNull(),
    managerUserId: uuid("manager_user_id").notNull(),
    memberUserId: uuid("member_user_id").notNull(),
    active: boolean("active").notNull().default(true),
    addedBy: uuid("added_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [index("staff_team_members_manager_idx").on(t.managerUserId, t.team)],
);
export type StaffTeamMember = typeof staffTeamMembers.$inferSelect;

/** Append-only (trigger shop_mrp_history_append_only): every change of a shop's own MRP. */
export const shopMrpHistory = pgTable(
  "shop_mrp_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id").notNull(),
    shopProductId: uuid("shop_product_id").notNull(),
    previousMrpPaise: bigint("previous_mrp_paise", { mode: "number" }),
    newMrpPaise: bigint("new_mrp_paise", { mode: "number" }).notNull(),
    changedBy: uuid("changed_by"),
    source: text("source", { enum: ["OWNER", "CHANGE_REQUEST", "ADMIN"] }).notNull(),
    approvalRequestId: uuid("approval_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shop_mrp_history_product_idx").on(t.shopProductId, t.createdAt)],
);

/* ======================================================== Documents (0173) */

export const STAFF_DOC_TYPES = [
  "GST_CERTIFICATE",
  "PAN",
  "SHOP_ACT",
  "FSSAI",
  "DRUG_LICENCE",
  "OTHER_LICENCE",
  "PRODUCT_CATALOGUE",
  "PRODUCT_IMAGE",
  "SPECIFICATION",
  "PRICE_LIST",
  "SHOP_PHOTO",
  "AGREEMENT",
  "CERTIFICATE",
  "OTHER",
] as const;
export type StaffDocType = (typeof STAFF_DOC_TYPES)[number];

export const staffDocuments = pgTable(
  "staff_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id").notNull(),
    shopProductId: uuid("shop_product_id"),
    docType: text("doc_type", { enum: STAFF_DOC_TYPES }).notNull(),
    title: text("title").notNull(),
    currentVersion: integer("current_version").notNull().default(1),
    verificationStatus: text("verification_status", { enum: ["UNVERIFIED", "VERIFIED", "REJECTED"] }).notNull().default("UNVERIFIED"),
    verifiedBy: uuid("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ticketId: uuid("ticket_id"),
    status: text("status", { enum: ["ACTIVE", "DELETED"] }).notNull().default("ACTIVE"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedBy: uuid("deleted_by"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("staff_documents_shop_idx").on(t.shopId, t.status)],
);
export type StaffDocument = typeof staffDocuments.$inferSelect;

const bytea = customType<{ data: Buffer; default: false }>({ dataType: () => "bytea" });

/** A version is never changed (trigger staff_document_versions_immutable): a new upload is a new version. */
export const staffDocumentVersions = pgTable("staff_document_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => staffDocuments.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  data: bytea("data").notNull(),
  uploadedBy: uuid("uploaded_by").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
});
export type StaffDocumentVersion = typeof staffDocumentVersions.$inferSelect;
