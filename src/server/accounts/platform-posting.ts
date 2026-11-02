/**
 * GoKesari's activity in the shop's own books (billing v2, docs/billing §6.1):
 * every online sale, credit note, fee, tax and payout GoKesari records for a
 * shop is posted as a double-entry voucher in the shop's ledger, so the day
 * book, cash book, trial balance, balance sheet and the Tally export show the
 * whole business, not only counter sales and purchases.
 *
 *   Online invoice (tax_invoices)   Dr GoKesari account (cash: COD the shop took)
 *                                   Cr Sales, Output GST                      SALE
 *   Credit note (credit_notes)      Dr Sales, Output GST  Cr GoKesari account  SALES_RETURN
 *   Payout lines (payout_cycle_lines):
 *     COMMISSION / PLATFORM_FEE     Dr Commission & fees  Cr GoKesari account JOURNAL
 *     FEE_GST                       Dr Input GST (ITC on GoKesari's invoice)   JOURNAL
 *     TCS / TDS                     Dr TCS / TDS receivable                    JOURNAL
 *     ADJUSTMENT / PLATFORM_NOTE    GoKesari account vs. an expense line       JOURNAL
 *     GOODS / REFUND                only when the order has no tax invoice / credit note
 *   Payout paid (payout_items)      Dr Bank  Cr GoKesari account               RECEIPT
 *   Shop wallet (shop_wallet_transactions):
 *     TOP_UP paid by the shop       Dr GoKesari account  Cr Bank               PAYMENT
 *     COMMISSION / DELIVERY_CHARGE  Dr Commission / Delivery  Cr GoKesari account
 *
 * "GoKesari account" (GOKESARI_ACCOUNT) is money GoKesari holds for the shop:
 * unsettled sales and the prepaid wallet. Each source row is posted once
 * (source_type + source_id); a cancelled invoice's voucher is reversed. Runs
 * under a per-shop lock, from the daily cron and the accounts hub, while
 * billing_v2 is on. Stock for online orders is already in the stock ledger
 * (database trigger, migration 0076).
 */
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db, type DbClient } from "@/server/db";
import {
  accLedgerEntries,
  creditNotes,
  orderMoneyFlows,
  payoutCycleLines,
  payoutItems,
  shopWalletTransactions,
  taxInvoices,
} from "@/server/db/schema";
import type { InvoiceSnapshot } from "@/server/services/invoices";
import { isFeatureEnabled, isFeatureEnabledForShop } from "@/server/services/feature-flags";
import { postVoucher, reverseSource, type Leg } from "./books";

const istDay = (at: Date) => new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);

export interface PostingResult {
  posted: number;
  reversed: number;
}

const gstLegs = (side: "debit" | "credit", t: { cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise?: number }, kind: "OUTPUT" | "INPUT"): Leg[] => {
  const k = side === "debit" ? "debitPaise" : "creditPaise";
  return [
    { account: `GST_${kind}_CGST` as const, [k]: t.cgstPaise },
    { account: `GST_${kind}_SGST` as const, [k]: t.sgstPaise },
    { account: `GST_${kind}_IGST` as const, [k]: t.igstPaise },
    { account: `GST_${kind}_CESS` as const, [k]: t.cessPaise ?? 0 },
  ];
};

/** Posts everything GoKesari recorded for the shop that is not in its books yet. */
export async function postGokesariActivity(shopId: string, options: { limit?: number } = {}): Promise<PostingResult> {
  if (!(await isFeatureEnabledForShop("billing_v2", shopId))) return { posted: 0, reversed: 0 };
  const limit = options.limit ?? 2000;
  return db.transaction(async (tx) => {
    // One poster per shop at a time; a second waits and then finds everything posted.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`books-post:${shopId}`}))`);
    const postedRows = await tx
      .selectDistinct({ sourceId: accLedgerEntries.sourceId, sourceType: accLedgerEntries.sourceType })
      .from(accLedgerEntries)
      .where(and(eq(accLedgerEntries.shopId, shopId), inArray(accLedgerEntries.sourceType, ["ORDER", "SETTLEMENT", "WALLET"])));
    const posted = new Set(postedRows.map((r) => `${r.sourceType}:${r.sourceId}`));
    let count = 0;
    let reversed = 0;
    const post = async (sourceType: "ORDER" | "SETTLEMENT" | "WALLET", sourceId: string, voucher: { voucherType: Parameters<typeof postVoucher>[0]["voucherType"]; date: Date; docRef: string; narration: string; legs: Leg[] }) => {
      if (posted.has(`${sourceType}:${sourceId}`)) return;
      await postVoucher({ shopId, voucherType: voucher.voucherType, entryDate: istDay(voucher.date), sourceType, sourceId, docRef: voucher.docRef, narration: voucher.narration, createdBy: null, legs: voucher.legs }, tx);
      posted.add(`${sourceType}:${sourceId}`);
      count += 1;
    };

    /* ------------------------------------------------- online invoices */
    const invoices = await tx
      .select({ inv: taxInvoices, collectedBy: orderMoneyFlows.collectedBy })
      .from(taxInvoices)
      .leftJoin(orderMoneyFlows, eq(orderMoneyFlows.orderId, taxInvoices.orderId))
      .where(eq(taxInvoices.shopId, shopId))
      .orderBy(asc(taxInvoices.issuedAt))
      .limit(limit);
    const invoicedOrders = new Set(invoices.map((r) => r.inv.orderId));
    for (const { inv, collectedBy } of invoices) {
      const key = `ORDER:${inv.id}`;
      if (inv.status === "CANCELLED") {
        if (posted.has(key)) {
          const undone = await reverseSource(shopId, "ORDER", inv.id, istDay(inv.cancelledAt ?? new Date()), null, `Invoice ${inv.invoiceNumber} cancelled`, tx);
          reversed += undone.length;
        }
        continue;
      }
      const s = inv.snapshot as unknown as InvoiceSnapshot;
      // The shop took the cash itself (money-flow record); otherwise GoKesari holds the money.
      const cashSale = collectedBy === "SHOP";
      await post("ORDER", inv.id, {
        voucherType: "SALE",
        date: inv.issuedAt,
        docRef: inv.invoiceNumber,
        narration: `GoKesari order ${s.orderNumber}`,
        legs: [
          { account: cashSale ? "CASH" : "GOKESARI_ACCOUNT", debitPaise: inv.totalPaise },
          { account: "SALES", creditPaise: inv.taxablePaise },
          ...gstLegs("credit", { ...inv, cessPaise: s.totals.cessPaise }, "OUTPUT"),
        ],
      });
    }

    /* ---------------------------------------------------- credit notes */
    const notes = await tx.select().from(creditNotes).where(eq(creditNotes.shopId, shopId)).orderBy(asc(creditNotes.issuedAt)).limit(limit);
    const creditedOrders = new Set(notes.map((n) => n.orderId));
    for (const n of notes) {
      const cess = (n.snapshot as { totals?: { cessPaise?: number } }).totals?.cessPaise ?? 0;
      await post("ORDER", n.id, {
        voucherType: "SALES_RETURN",
        date: n.issuedAt,
        docRef: n.creditNoteNumber,
        narration: `Credit note on a GoKesari order (${n.reason.toLowerCase()})`,
        legs: [
          { account: "SALES", debitPaise: n.taxablePaise },
          ...gstLegs("debit", { ...n, cessPaise: cess }, "OUTPUT"),
          { account: "GOKESARI_ACCOUNT", creditPaise: n.totalPaise },
        ],
      });
    }

    /* ---------------------------------------------------- payout lines */
    const lines = await tx.select().from(payoutCycleLines).where(eq(payoutCycleLines.shopId, shopId)).orderBy(asc(payoutCycleLines.createdAt)).limit(limit * 4);
    for (const l of lines) {
      const amount = l.amountPaise;
      const date = new Date(`${l.occurredOn}T12:00:00+05:30`);
      const meta = l.meta as { cgst?: number; sgst?: number; igst?: number; orderNumber?: string; orderId?: string };
      const ref = meta.orderNumber ?? l.description.slice(0, 60);
      const journal = (legs: Leg[], narration = l.description) => post("SETTLEMENT", l.id, { voucherType: "JOURNAL", date, docRef: ref, narration, legs });
      switch (l.lineType) {
        case "COMMISSION":
        case "PLATFORM_FEE":
          if (amount !== 0) await journal([{ account: "COMMISSION_EXPENSE", debitPaise: -amount }, { account: "GOKESARI_ACCOUNT", creditPaise: -amount }]);
          break;
        case "FEE_GST": {
          const sign = amount < 0 ? 1 : -1;
          const t = { cgstPaise: sign * (meta.cgst ?? 0), sgstPaise: sign * (meta.sgst ?? 0), igstPaise: sign * (meta.igst ?? 0) };
          const split = t.cgstPaise + t.sgstPaise + t.igstPaise === -amount ? t : { cgstPaise: 0, sgstPaise: 0, igstPaise: -amount };
          await journal([...gstLegs("debit", split, "INPUT"), { account: "GOKESARI_ACCOUNT", creditPaise: -amount }]);
          break;
        }
        case "TCS":
          if (amount !== 0) await journal([{ account: "TCS_RECEIVABLE", debitPaise: -amount }, { account: "GOKESARI_ACCOUNT", creditPaise: -amount }]);
          break;
        case "TDS":
          if (amount !== 0) await journal([{ account: "TDS_RECEIVABLE", debitPaise: -amount }, { account: "GOKESARI_ACCOUNT", creditPaise: -amount }]);
          break;
        case "ADJUSTMENT":
        case "PLATFORM_NOTE":
          if (amount !== 0) await journal([{ account: "GOKESARI_ACCOUNT", debitPaise: amount }, { account: "EXPENSE", subAccount: "GoKesari adjustment", creditPaise: amount }]);
          break;
        case "GOODS":
          // Orders invoiced through GoKesari are posted from their invoice; without one, from here.
          if (l.sourceType === "order_financials" && !invoicedOrders.has(l.sourceId) && amount !== 0) {
            await journal([{ account: "GOKESARI_ACCOUNT", debitPaise: amount }, { account: "SALES", creditPaise: amount }], `GoKesari order ${ref} (no tax invoice)`);
          }
          break;
        case "REFUND":
          if (meta.orderId && !creditedOrders.has(meta.orderId) && !invoicedOrders.has(meta.orderId) && amount !== 0) {
            await journal([{ account: "SALES", debitPaise: -amount }, { account: "GOKESARI_ACCOUNT", creditPaise: -amount }]);
          }
          break;
        default:
          // DELIVERY_CHARGE and REGISTRATION_FEE are informational (0); SEC95_GST is already out of the sale
          // (the restaurant's bill of supply is booked without that GST); WALLET_TOPUP and
          // CARRY_FORWARD move money inside the GoKesari account.
          break;
      }
    }

    /* ----------------------------------------------------- payouts paid */
    const paid = await tx
      .select()
      .from(payoutItems)
      .where(and(eq(payoutItems.shopId, shopId), eq(payoutItems.status, "PAID"), isNotNull(payoutItems.paidAt)))
      .limit(limit);
    for (const p of paid) {
      await post("SETTLEMENT", p.id, {
        voucherType: "RECEIPT",
        date: p.paidAt!,
        docRef: p.utr ?? "GoKesari payout",
        narration: `Payout from GoKesari${p.utr ? ` (UTR ${p.utr})` : ""}`,
        legs: [
          { account: "BANK", debitPaise: p.amountPaise },
          { account: "GOKESARI_ACCOUNT", creditPaise: p.amountPaise },
        ],
      });
    }

    /* ------------------------------------------------------ shop wallet */
    const wallet = await tx.select().from(shopWalletTransactions).where(eq(shopWalletTransactions.shopId, shopId)).orderBy(asc(shopWalletTransactions.seq)).limit(limit * 2);
    for (const w of wallet) {
      const debit = w.direction === "DEBIT";
      const legsFor = (): Leg[] | null => {
        switch (w.type) {
          case "TOP_UP":
            // Paid in by the shop (a payment) — a top-up from a payout stays inside the GoKesari account.
            return w.paymentId ? [{ account: "GOKESARI_ACCOUNT", debitPaise: w.amountPaise }, { account: "BANK", creditPaise: w.amountPaise }] : null;
          case "COMMISSION":
            return [{ account: "COMMISSION_EXPENSE", debitPaise: w.amountPaise }, { account: "GOKESARI_ACCOUNT", creditPaise: w.amountPaise }];
          case "COMMISSION_REFUND":
            return [{ account: "GOKESARI_ACCOUNT", debitPaise: w.amountPaise }, { account: "COMMISSION_EXPENSE", creditPaise: w.amountPaise }];
          case "DELIVERY_CHARGE":
            return [{ account: "DELIVERY_EXPENSE", debitPaise: w.amountPaise }, { account: "GOKESARI_ACCOUNT", creditPaise: w.amountPaise }];
          default:
            return debit
              ? [{ account: "EXPENSE", subAccount: "GoKesari wallet adjustment", debitPaise: w.amountPaise }, { account: "GOKESARI_ACCOUNT", creditPaise: w.amountPaise }]
              : [{ account: "GOKESARI_ACCOUNT", debitPaise: w.amountPaise }, { account: "EXPENSE", subAccount: "GoKesari wallet adjustment", creditPaise: w.amountPaise }];
        }
      };
      const legs = legsFor();
      if (!legs) continue;
      await post("WALLET", w.id, {
        voucherType: w.type === "TOP_UP" ? "PAYMENT" : "JOURNAL",
        date: w.createdAt,
        docRef: w.type === "TOP_UP" ? "Wallet top-up" : w.reason.slice(0, 60),
        narration: `Shop wallet: ${w.reason}`,
        legs,
      });
    }
    return { posted: count, reversed };
  });
}

/** Shops with GoKesari activity, for the daily cron. */
export async function postGokesariActivityForAllShops(client: DbClient = db): Promise<{ shops: number; posted: number; failed: number }> {
  if (!(await isFeatureEnabled("billing_v2"))) return { shops: 0, posted: 0, failed: 0 };
  const rows = await client.selectDistinct({ shopId: taxInvoices.shopId }).from(taxInvoices);
  const more = await client.selectDistinct({ shopId: payoutCycleLines.shopId }).from(payoutCycleLines);
  const ids = [...new Set([...rows, ...more].map((r) => r.shopId))];
  let posted = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      posted += (await postGokesariActivity(id)).posted;
    } catch (error) {
      failed += 1;
      console.error("[books] GoKesari posting failed for shop", id, error);
    }
  }
  return { shops: ids.length, posted, failed };
}
