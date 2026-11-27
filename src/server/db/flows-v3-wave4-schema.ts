/**
 * Flow spec v3, wave 4 (docs/flows-v3/wave4.md; drizzle/0224_flows_v3_wave4.sql; flag flow_f22).
 *
 * dealer_commission_invoices: the commission invoice of a GST-registered dealer's monthly payout — the dealer is the
 * supplier, GoKesari the recipient; one per payout (unique batch_id), numbered "<prefix>/<yyYY>/<000001>" per
 * financial year from dealer_commission_invoice_counters (row-locked, gapless). Re-exported by schema.ts.
 */
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { dealerPayoutBatches, dealers } from "./schema";

export interface DealerCommissionInvoiceSnapshot {
  supplier: { name: string; gstin: string; address: string | null; state: string | null };
  recipient: { name: string; gstin: string | null; address: string | null; state: string | null };
  description: string;
  sac: string;
  periodMonth: string | null;
  amountInWords: string;
}

export const dealerCommissionInvoices = pgTable(
  "dealer_commission_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => dealerPayoutBatches.id, { onDelete: "restrict" }),
    dealerId: uuid("dealer_id")
      .notNull()
      .references(() => dealers.id, { onDelete: "restrict" }),
    invoiceNumber: text("invoice_number").notNull(),
    financialYear: text("financial_year").notNull(),
    periodMonth: text("period_month"),
    supplierGstin: text("supplier_gstin").notNull(),
    supply: text("supply", { enum: ["INTRA", "INTER"] }).notNull(),
    taxablePaise: integer("taxable_paise").notNull(),
    gstRateBp: integer("gst_rate_bp").notNull(),
    cgstPaise: integer("cgst_paise").notNull().default(0),
    sgstPaise: integer("sgst_paise").notNull().default(0),
    igstPaise: integer("igst_paise").notNull().default(0),
    totalPaise: integer("total_paise").notNull(),
    snapshot: jsonb("snapshot").$type<DealerCommissionInvoiceSnapshot>().notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("dealer_commission_invoices_batch_uq").on(t.batchId),
    uniqueIndex("dealer_commission_invoices_number_uq").on(t.invoiceNumber),
    index("dealer_commission_invoices_dealer_idx").on(t.dealerId, t.issuedAt),
  ],
);
export type DealerCommissionInvoice = typeof dealerCommissionInvoices.$inferSelect;

export const dealerCommissionInvoiceCounters = pgTable(
  "dealer_commission_invoice_counters",
  {
    prefix: text("prefix").notNull(),
    financialYear: text("financial_year").notNull(),
    lastNumber: integer("last_number").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.prefix, t.financialYear] })],
);
