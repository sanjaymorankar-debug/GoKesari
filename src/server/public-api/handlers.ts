/**
 * What the public REST API reads and writes (billing v2, docs/billing §8): the
 * canonical books, the shop's invoices, stock and parties; vouchers and item
 * tax / price updates go in through the same import as files (masters first,
 * keyed, conflicts held). Every amount in paise, dates ISO.
 */
import { and, eq, gte, lt } from "drizzle-orm";

import { db } from "@/server/db";
import { accParties, accSalesInvoices, shops, taxInvoices } from "@/server/db/schema";
import { stockSummary } from "@/server/accounts/stock";
import { invoiceJson } from "@/server/invoicing/outputs";
import { importForTool } from "@/server/sync/engine";
import { buildCanonicalBooks } from "@/server/sync/model";

const IST = (iso: string) => new Date(`${iso}T00:00:00+05:30`);

export async function apiBooks(shopId: string, from: string, to: string) {
  return { schema: "gokesari.books/1", ...(await buildCanonicalBooks(shopId, from, to)) };
}

export async function apiInvoices(shopId: string, from: string, to: string) {
  const online = await db.select().from(taxInvoices).where(and(eq(taxInvoices.shopId, shopId), gte(taxInvoices.issuedAt, IST(from)), lt(taxInvoices.issuedAt, IST(to))));
  const counter = await db.select().from(accSalesInvoices).where(and(eq(accSalesInvoices.shopId, shopId), gte(accSalesInvoices.invoiceDate, from), lt(accSalesInvoices.invoiceDate, to)));
  return { online: await Promise.all(online.map((i) => invoiceJson(i))), counter };
}

export async function apiStock(shopId: string) {
  const s = await stockSummary(shopId);
  return { asOf: s.asOf, method: s.method, totalValuePaise: s.totalValuePaise, items: s.rows.map((r) => ({ id: r.shopProductId, name: r.name, unit: r.sellableUnit, qtyMilli: r.qtyMilli, valuePaise: r.valuePaise, status: r.status })) };
}

export async function apiParties(shopId: string) {
  return db.select({ id: accParties.id, kind: accParties.kind, name: accParties.name, gstin: accParties.gstin, stateCode: accParties.stateCode, phone: accParties.phone, email: accParties.email }).from(accParties).where(eq(accParties.shopId, shopId));
}

/** Vouchers / masters / item updates in canonical JSON, imported as a GoKesari-standard file. */
export async function apiImport(shopId: string, body: Record<string, unknown>) {
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId));
  const payload = { schema: "gokesari.books/1", ledgers: body.ledgers ?? [], stockItems: body.stockItems ?? [], vouchers: body.vouchers ?? [] };
  return importForTool(shopId, "GENERIC", { name: "api.json", bytes: Buffer.from(JSON.stringify(payload)) }, { id: shop.ownerId, role: "SHOP_OWNER" });
}
