/**
 * Tax register (docs/tax-register/README.md; drizzle/0184_tax_register.sql).
 *
 *   tax_change_requests   the Accountant (or an admin) proposes a change to a tax setting; the CA
 *                         approves (never their own) and it is applied through the setting's own
 *                         service, or sends it back
 *   tax_param_approvals   the CA's approval of a setting's current value (settings kept in rules,
 *                         GST rules, HSN rates) — the value is "approved" while it still equals this
 *   ca_action_items       questions for the CA, answered by the Accountant and approved by the CA,
 *                         each listing the switches it holds back
 *   ca_action_item_notes  the thread of an item (notes, send-backs, approvals)
 *
 * Users are not referenced by foreign key (the service checks those links). Re-exported by schema.ts.
 */
import { date, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const TAX_CHANGE_KINDS = [
  "STATUTORY_ROW",
  "STATUTORY_CONFIRM",
  "COMMISSION_TDS_ROW",
  "COMMISSION_TDS_CONFIRM",
  "GST_RULE",
  "HSN_RATES",
  "PRODUCT_GST",
  "RULE_FIELDS",
  "FRANCHISE_GST",
  "APPROVE_CURRENT",
] as const;
export type TaxChangeKind = (typeof TAX_CHANGE_KINDS)[number];

export const TAX_CHANGE_STATUSES = ["SUBMITTED", "SENT_BACK", "WITHDRAWN", "APPLIED", "APPLY_FAILED"] as const;
export type TaxChangeStatus = (typeof TAX_CHANGE_STATUSES)[number];

export const taxChangeRequests = pgTable(
  "tax_change_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<TaxChangeKind>().notNull(),
    /** The register key it changes (e.g. rule:riderPayouts.tdsRatePanBp, statutory:GST_TCS_SEC52). */
    targetKeys: jsonb("target_keys").$type<string[]>().notNull().default([]),
    title: text("title").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** What the setting held when it was proposed (shown to the CA beside the new value). */
    currentValue: jsonb("current_value").$type<unknown>(),
    reason: text("reason").notNull(),
    legalReference: text("legal_reference"),
    status: text("status").$type<TaxChangeStatus>().notNull().default("SUBMITTED"),
    proposedBy: uuid("proposed_by").notNull(),
    proposedRole: text("proposed_role").notNull(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    applyError: text("apply_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tax_change_requests_status_idx").on(t.status, t.createdAt)],
);
export type TaxChangeRequest = typeof taxChangeRequests.$inferSelect;

export const taxParamApprovals = pgTable(
  "tax_param_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paramKey: text("param_key").notNull(),
    value: jsonb("value").$type<unknown>(),
    approvedBy: uuid("approved_by").notNull(),
    changeRequestId: uuid("change_request_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tax_param_approvals_key_idx").on(t.paramKey, t.approvedAt)],
);
export type TaxParamApproval = typeof taxParamApprovals.$inferSelect;

export const CA_ITEM_STATUSES = ["OPEN", "SUBMITTED", "NEEDS_INFO", "APPROVED", "CLOSED"] as const;
export type CaItemStatus = (typeof CA_ITEM_STATUSES)[number];
export const CA_ITEM_PRIORITIES = ["HIGH", "NORMAL", "LOW"] as const;
export type CaItemPriority = (typeof CA_ITEM_PRIORITIES)[number];

export const caActionItems = pgTable(
  "ca_action_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ref: text("ref").notNull(),
    area: text("area").notNull().default("GST"),
    title: text("title").notNull(),
    question: text("question").notNull(),
    /** Switches and settings it holds back (e.g. tcs_engine, documentNumbering:GST16, statutory:IT_TDS_194O). */
    blocks: jsonb("blocks").$type<string[]>().notNull().default([]),
    status: text("status").$type<CaItemStatus>().notNull().default("OPEN"),
    priority: text("priority").$type<CaItemPriority>().notNull().default("NORMAL"),
    dueOn: date("due_on", { mode: "string" }),
    answer: text("answer"),
    answeredBy: uuid("answered_by"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ca_action_items_ref_unique").on(t.ref)],
);
export type CaActionItem = typeof caActionItems.$inferSelect;

export const caActionItemNotes = pgTable(
  "ca_action_item_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => caActionItems.id, { onDelete: "cascade" }),
    authorId: uuid("author_id"),
    authorRole: text("author_role"),
    /** NOTE, SUBMITTED, SENT_BACK, APPROVED, REOPENED, CLOSED. */
    kind: text("kind").notNull().default("NOTE"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ca_action_item_notes_item_idx").on(t.itemId, t.createdAt)],
);
export type CaActionItemNote = typeof caActionItemNotes.$inferSelect;
