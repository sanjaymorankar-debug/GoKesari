/**
 * Counter billing that keeps working offline (billing v2, docs/billing §4.7;
 * §13 scenario 16). The POS screen keeps the shop's item list and queues bills
 * on the device while the network is down; on reconnect it sends them here.
 * Each bill becomes a counter-sale invoice in the shop's one series — the
 * number is given now, in arrival order, so the series has no gaps — and the
 * device's own id (clientRef) makes a re-sent bill return the same invoice
 * (no duplicates). What changed meanwhile is reported per bill:
 *
 *   CREATED    issued now
 *   DUPLICATE  already issued from an earlier sync (same invoice returned)
 *   REJECTED   cannot be issued (an item no longer in the shop, bad data)
 *   + warnings price changed since the device's list, stock now below zero
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/server/db";
import { accSalesInvoices, products, shopProducts } from "@/server/db/schema";
import { todayIst } from "./books";
import { createSalesInvoiceOnce } from "./sales";

export async function posItems(shopId: string) {
  const rows = await db
    .select({ sp: shopProducts, p: products })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(and(eq(shopProducts.shopId, shopId), eq(shopProducts.isActive, true)));
  return rows.map(({ sp, p }) => ({
    id: sp.id,
    name: p.name + (p.variant ? ` ${p.variant}` : ""),
    unit: p.unit,
    barcode: p.barcode ?? p.gtin ?? null,
    hsn: sp.hsnCode ?? p.hsnCode ?? null,
    gstRateBp: sp.gstRateBp ?? p.gstRateBp ?? 0,
    pricePaise: sp.offlinePricePaise ?? sp.onlinePricePaise ?? p.mrpPaise ?? null,
    stock: (sp.offlineStock ?? 0) + (sp.onlineStock ?? 0),
  }));
}

export const posBillSchema = z.object({
  clientRef: z.string().trim().min(8).max(64),
  /** When the bill was made on the device (ISO). */
  createdAt: z.string().datetime({ offset: true }),
  paymentMode: z.enum(["CASH", "UPI", "CARD", "CREDIT"]),
  buyerName: z.string().trim().max(160).nullable().optional(),
  buyerGstin: z.string().trim().toUpperCase().max(15).nullable().optional(),
  lines: z
    .array(z.object({ shopProductId: z.string().uuid(), name: z.string().trim().min(1).max(200), qtyMilli: z.number().int().positive(), pricePaise: z.number().int().min(0), gstRateBp: z.number().int().min(0).max(10_000) }))
    .min(1)
    .max(200),
});
export type PosBill = z.infer<typeof posBillSchema>;

export interface PosSyncResult {
  clientRef: string;
  status: "CREATED" | "DUPLICATE" | "REJECTED";
  invoiceId?: string;
  invoiceNo?: string;
  totalPaise?: number;
  reason?: string;
  warnings: string[];
}

const istDateOf = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);

export async function syncPosBills(shopId: string, bills: PosBill[], actor: { id: string }): Promise<PosSyncResult[]> {
  const parsed = z.array(posBillSchema).max(200).parse(bills);
  // In the order the bills were made, so the numbers follow the counter's order.
  const ordered = [...parsed].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const ids = [...new Set(ordered.flatMap((b) => b.lines.map((l) => l.shopProductId)))];
  const listings = ids.length ? await db.select().from(shopProducts).where(and(eq(shopProducts.shopId, shopId), inArray(shopProducts.id, ids))) : [];
  const listingById = new Map(listings.map((l) => [l.id, l]));
  const out: PosSyncResult[] = [];
  for (const bill of ordered) {
    const warnings: string[] = [];
    const [existing] = await db.select().from(accSalesInvoices).where(and(eq(accSalesInvoices.shopId, shopId), eq(accSalesInvoices.clientRef, bill.clientRef)));
    if (existing) {
      out.push({ clientRef: bill.clientRef, status: "DUPLICATE", invoiceId: existing.id, invoiceNo: existing.invoiceNo, totalPaise: existing.totalPaise, warnings });
      continue;
    }
    const missing = bill.lines.filter((l) => !listingById.get(l.shopProductId)?.isActive);
    if (missing.length) {
      out.push({ clientRef: bill.clientRef, status: "REJECTED", reason: `No longer sold by the shop: ${missing.map((m) => m.name).join(", ")}. Bill it again without them.`, warnings });
      continue;
    }
    for (const l of bill.lines) {
      const now = listingById.get(l.shopProductId)!;
      const current = now.offlinePricePaise ?? now.onlinePricePaise;
      if (current != null && current !== l.pricePaise) warnings.push(`${l.name}: billed at ₹${(l.pricePaise / 100).toFixed(2)}, the price is now ₹${(current / 100).toFixed(2)}.`);
      if ((now.offlineStock ?? 0) + (now.onlineStock ?? 0) < l.qtyMilli / 1000) warnings.push(`${l.name}: stock goes below zero — count it.`);
    }
    const date = istDateOf(bill.createdAt);
    try {
      const { invoice: inv, created } = await createSalesInvoiceOnce(
        shopId,
        {
          clientRef: bill.clientRef,
          invoiceDate: date > todayIst() ? todayIst() : date,
          paymentMode: bill.paymentMode,
          buyerName: bill.buyerName ?? (bill.paymentMode === "CREDIT" ? "Counter customer" : null),
          buyerGstin: bill.buyerGstin ?? null,
          pricesIncludeTax: true,
          note: `Counter bill ${bill.clientRef.slice(0, 8)}`,
          lines: bill.lines.map((l) => ({ shopProductId: l.shopProductId, description: l.name, qtyMilli: l.qtyMilli, ratePaise: l.pricePaise, gstRateBp: l.gstRateBp })),
        },
        actor,
      );
      // Not created here: a parallel sync of the same bill issued it a moment ago.
      out.push({ clientRef: bill.clientRef, status: created ? "CREATED" : "DUPLICATE", invoiceId: inv.id, invoiceNo: inv.invoiceNo, totalPaise: inv.totalPaise, warnings });
    } catch (error) {
      out.push({ clientRef: bill.clientRef, status: "REJECTED", reason: error instanceof Error ? error.message : "Could not be issued.", warnings });
    }
  }
  return out;
}
