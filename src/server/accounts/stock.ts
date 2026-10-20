/**
 * Stock ledger service (docs/inventory-accounting-2026-10, Part 1).
 *
 * Current stock of a listing = the sum of its inv_stock_ledger rows. The
 * listing's own counts (shop_products.online_stock / offline_stock, whole
 * units, which checkout reads) are kept equal to the ledger:
 *
 *   online_stock  = floor(ONLINE ledger total / 1000)
 *   offline_stock = floor(OFFLINE ledger total / 1000)
 *
 * Changes made by the existing code (orders, cancellations, the catalogue
 * screen) arrive through the database triggers of migration 0076. Changes
 * made here (purchases, corrections, write-offs, adjustments) write their
 * own ledger rows — with cost, batch and source document — then move the
 * listing's count by the whole units gained or lost, and also write the
 * existing inventory_movements history, with the triggers switched off for
 * the transaction so nothing is counted twice.
 */
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import { notFound, validationFailed } from "@/lib/errors";
import type { StockMovementType, StockSourceType, ValuationMethod } from "@/lib/accounts/constants";
import { sellableUnitLabel } from "@/lib/accounts/units";
import { batchBalances, valueStock, type ValuationEntry } from "@/lib/accounts/valuation";
import { db, type DbClient } from "@/server/db";
import {
  inventoryMovements,
  invBatches,
  invProductSettings,
  invStockLedger,
  products,
  shopProducts,
  shops,
} from "@/server/db/schema";
import { evaluateStockAlerts, resolveThresholds } from "@/server/services/inventory-alerts";
import { getSettings, logChange, manageLedgerInThisTransaction, todayIst } from "./books";
import { touchSellerRow } from "@/server/db/split/gate";
import { upsertRow } from "@/server/db/split/upsert";

export interface StockPosting {
  shopId: string;
  shopProductId: string;
  channel: "ONLINE" | "OFFLINE";
  movementType: StockMovementType;
  qtyMilli: number;
  unitCostPaise?: number | null;
  unitPricePaise?: number | null;
  batchId?: string | null;
  sourceType: StockSourceType;
  sourceId?: string | null;
  sourceLineId?: string | null;
  docRef?: string | null;
  reversesId?: string | null;
  entryDate?: string;
  note?: string | null;
  createdBy: string | null;
}

const floorUnits = (milli: number) => Math.floor(milli / 1000);

async function channelTotal(shopProductId: string, channel: "ONLINE" | "OFFLINE", client: DbClient): Promise<number> {
  const [row] = await client
    .select({ total: sql<number>`coalesce(sum(${invStockLedger.qtyMilli}), 0)::bigint` })
    .from(invStockLedger)
    .where(and(eq(invStockLedger.shopProductId, shopProductId), eq(invStockLedger.channel, channel)));
  return Number(row?.total ?? 0);
}

/**
 * Writes ledger rows and moves the listings' counts to match. Must run
 * inside the caller's transaction. Returns the ledger row ids in order.
 * A listing's count never goes below zero: if an outbound posting would
 * take the ledger below zero (stock already sold), an ADJUSTMENT row brings
 * it back to zero and says so.
 */
export async function postStock(entries: StockPosting[], client: DbClient): Promise<string[]> {
  if (entries.length === 0) return [];
  await manageLedgerInThisTransaction(client);
  const ids: string[] = [];
  const touched = new Set<string>();
  for (const e of entries) {
    if (!Number.isInteger(e.qtyMilli) || e.qtyMilli === 0) continue;
    const [listing] = await client
      .select({ id: shopProducts.id, shopId: shopProducts.shopId, onlineStock: shopProducts.onlineStock, offlineStock: shopProducts.offlineStock })
      .from(shopProducts)
      .where(eq(shopProducts.id, e.shopProductId))
      .for("update");
    if (!listing || listing.shopId !== e.shopId) throw notFound("Product");
    // The count comes from the ledger (seller rows); a posting that leaves the whole units as they were does not update the listing.
    await touchSellerRow(client, shopProducts, listing.id);
    const before = await channelTotal(e.shopProductId, e.channel, client);
    const [row] = await client
      .insert(invStockLedger)
      .values({
        shopId: e.shopId,
        shopProductId: e.shopProductId,
        channel: e.channel,
        movementType: e.movementType,
        qtyMilli: e.qtyMilli,
        unitCostPaise: e.unitCostPaise ?? null,
        unitPricePaise: e.unitPricePaise ?? null,
        batchId: e.batchId ?? null,
        sourceType: e.sourceType,
        sourceId: e.sourceId ?? null,
        sourceLineId: e.sourceLineId ?? null,
        docRef: e.docRef ?? null,
        reversesId: e.reversesId ?? null,
        entryDate: e.entryDate ?? todayIst(),
        note: e.note ?? null,
        createdBy: e.createdBy,
      })
      .returning({ id: invStockLedger.id });
    ids.push(row.id);
    let after = before + e.qtyMilli;
    if (after < 0) {
      await client.insert(invStockLedger).values({
        shopId: e.shopId,
        shopProductId: e.shopProductId,
        channel: e.channel,
        movementType: "ADJUSTMENT",
        qtyMilli: -after,
        sourceType: "MANUAL",
        sourceId: e.sourceId ?? null,
        docRef: e.docRef ?? null,
        entryDate: e.entryDate ?? todayIst(),
        note: "Stock cannot go below zero: some of these goods were already sold. Check the physical stock.",
        createdBy: e.createdBy,
      });
      after = 0;
    }
    const current = e.channel === "ONLINE" ? listing.onlineStock : listing.offlineStock;
    // Keep the count equal to the ledger even if it had drifted before.
    const target = floorUnits(after);
    if (target !== current) {
      await client
        .update(shopProducts)
        .set(e.channel === "ONLINE" ? { onlineStock: target, updatedAt: new Date() } : { offlineStock: target, updatedAt: new Date() })
        .where(eq(shopProducts.id, e.shopProductId));
      await client.insert(inventoryMovements).values({
        shopProductId: e.shopProductId,
        channel: e.channel,
        deltaUnits: target - current,
        previousUnits: current,
        newUnits: target,
        reason: `${e.movementType.toLowerCase().replace(/_/g, " ")}${e.docRef ? ` ${e.docRef}` : ""} (books)`.slice(0, 200),
        createdBy: e.createdBy,
      });
    }
    touched.add(e.shopProductId);
  }
  for (const id of touched) await evaluateStockAlerts(id, client);
  return ids;
}

/* ------------------------------------------------------------- listings */

export interface ListingInfo {
  shopProductId: string;
  productId: string;
  name: string;
  unit: string;
  unitSizeMilli: number;
  sellableUnit: string;
  hsn: string | null;
  gstRateBp: number | null;
  barcode: string | null;
  gtin: string | null;
  mrpPaise: number | null;
  onlinePricePaise: number | null;
  offlinePricePaise: number | null;
  onlineStock: number;
  offlineStock: number;
  trackInventory: boolean;
  isActive: boolean;
}

export async function listListings(shopId: string, ids?: string[], client: DbClient = db): Promise<ListingInfo[]> {
  const rows = await client
    .select({ sp: shopProducts, p: products })
    .from(shopProducts)
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt), ids ? inArray(shopProducts.id, ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]) : undefined))
    .orderBy(asc(products.name));
  return rows.map(({ sp, p }) => ({
    shopProductId: sp.id,
    productId: p.id,
    name: p.name + (p.variant ? ` ${p.variant}` : ""),
    unit: p.unit,
    unitSizeMilli: p.unitSizeMilli,
    sellableUnit: sellableUnitLabel({ unit: p.unit, unitSizeMilli: p.unitSizeMilli }),
    hsn: sp.hsnCode ?? p.hsnCode,
    gstRateBp: sp.gstRateBp ?? p.gstRateBp,
    barcode: p.barcode,
    gtin: p.gtin,
    mrpPaise: p.mrpPaise,
    onlinePricePaise: sp.onlinePricePaise,
    offlinePricePaise: sp.offlinePricePaise,
    onlineStock: sp.onlineStock,
    offlineStock: sp.offlineStock,
    trackInventory: sp.trackInventory,
    isActive: sp.isActive,
  }));
}

/* ------------------------------------------------------------ summaries */

export interface StockRow {
  shopProductId: string;
  name: string;
  sellableUnit: string;
  qtyMilli: number;
  valuePaise: number;
  unitCostPaise: number;
  lastPurchaseRatePaise: number | null;
  uncostedQtyMilli: number;
  status: "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";
  reorder: boolean;
  lowStockThreshold: number;
  reorderLevel: number | null;
  /** Ledger and listing count disagree (should never happen; shown for support). */
  drift: boolean;
  trackBatches: boolean;
  nearestExpiry: string | null;
}

async function ledgerFor(shopId: string, until: string | null, client: DbClient) {
  return client
    .select({
      id: invStockLedger.id,
      shopProductId: invStockLedger.shopProductId,
      channel: invStockLedger.channel,
      movementType: invStockLedger.movementType,
      qtyMilli: invStockLedger.qtyMilli,
      unitCostPaise: invStockLedger.unitCostPaise,
      reversesId: invStockLedger.reversesId,
      entryDate: invStockLedger.entryDate,
      batchId: invStockLedger.batchId,
    })
    .from(invStockLedger)
    .where(and(eq(invStockLedger.shopId, shopId), until ? lte(invStockLedger.entryDate, until) : undefined))
    .orderBy(asc(invStockLedger.createdAt), asc(invStockLedger.id));
}

type LedgerRow = Awaited<ReturnType<typeof ledgerFor>>[number];

function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) out.set(key(r), [...(out.get(key(r)) ?? []), r]);
  return out;
}

const asEntries = (rows: LedgerRow[]): ValuationEntry[] =>
  rows.map((r) => ({ id: r.id, movementType: r.movementType, qtyMilli: r.qtyMilli, unitCostPaise: r.unitCostPaise, reversesId: r.reversesId, entryDate: r.entryDate }));

export async function stockSummary(shopId: string, options: { asOf?: string; method?: ValuationMethod } = {}): Promise<{ rows: StockRow[]; totalValuePaise: number; method: ValuationMethod; asOf: string }> {
  const settings = await getSettings(shopId);
  const method = options.method ?? settings.valuationMethod;
  const asOf = options.asOf ?? todayIst();
  const [listings, ledger, prodSettings, shop, batches] = await Promise.all([
    db
      .select({ sp: shopProducts, p: products })
      .from(shopProducts)
      .innerJoin(products, eq(shopProducts.productId, products.id))
      .where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)))
      .orderBy(asc(products.name)),
    ledgerFor(shopId, asOf, db),
    db.select().from(invProductSettings).where(eq(invProductSettings.shopId, shopId)),
    db.select().from(shops).where(eq(shops.id, shopId)).then((r) => r[0]),
    db.select().from(invBatches).where(eq(invBatches.shopId, shopId)),
  ]);
  const byListing = groupBy(ledger, (r) => r.shopProductId);
  const ps = new Map(prodSettings.map((s) => [s.shopProductId, s]));
  const rows: StockRow[] = listings.map(({ sp, p }) => {
    const entries = byListing.get(sp.id) ?? [];
    const setting = ps.get(sp.id);
    const fallback = setting?.lastPurchaseRatePaise ?? 0;
    const v = valueStock(asEntries(entries), method, fallback);
    const t = resolveThresholds(sp, p, shop);
    const units = floorUnits(v.qtyMilli);
    const online = entries.filter((e) => e.channel === "ONLINE").reduce((n, e) => n + e.qtyMilli, 0);
    const offline = entries.filter((e) => e.channel === "OFFLINE").reduce((n, e) => n + e.qtyMilli, 0);
    const drift = !options.asOf && (floorUnits(online) !== sp.onlineStock || floorUnits(offline) !== sp.offlineStock);
    let nearestExpiry: string | null = null;
    if (setting?.trackBatches) {
      const inbound = entries.filter((e) => e.batchId && e.qtyMilli > 0).map((e) => ({ batchId: e.batchId!, qtyMilli: e.qtyMilli, expiryDate: batches.find((b) => b.id === e.batchId)?.expiryDate ?? null }));
      const outUnbatched = -entries.filter((e) => e.qtyMilli < 0).reduce((n, e) => n + e.qtyMilli, 0);
      const left = batchBalances(inbound, outUnbatched);
      nearestExpiry = batches.filter((b) => (left.get(b.id) ?? 0) > 0 && b.expiryDate).map((b) => b.expiryDate!).sort()[0] ?? null;
    }
    return {
      shopProductId: sp.id,
      name: p.name + (p.variant ? ` ${p.variant}` : ""),
      sellableUnit: sellableUnitLabel({ unit: p.unit, unitSizeMilli: p.unitSizeMilli }),
      qtyMilli: v.qtyMilli,
      valuePaise: v.valuePaise,
      unitCostPaise: v.unitCostPaise,
      lastPurchaseRatePaise: setting?.lastPurchaseRatePaise ?? null,
      uncostedQtyMilli: v.uncostedQtyMilli,
      status: !sp.trackInventory ? "IN_STOCK" : units <= 0 ? "OUT_OF_STOCK" : t.lowStock > 0 && units <= t.lowStock ? "LOW_STOCK" : "IN_STOCK",
      reorder: sp.trackInventory && !t.alertsDisabled && t.reorderLevel != null && t.reorderLevel > 0 && units <= t.reorderLevel,
      lowStockThreshold: t.lowStock,
      reorderLevel: t.reorderLevel,
      drift,
      trackBatches: setting?.trackBatches ?? false,
      nearestExpiry,
    };
  });
  return { rows, totalValuePaise: rows.reduce((n, r) => n + r.valuePaise, 0), method, asOf };
}

/** Cost of goods sold and written-off value between two dates (inclusive from, exclusive to). */
export async function costOfGoods(shopId: string, from: string, to: string): Promise<{ cogsPaise: number; writeOffPaise: number; openingValuePaise: number; closingValuePaise: number }> {
  const settings = await getSettings(shopId);
  const [ledger, prodSettings] = await Promise.all([ledgerFor(shopId, null, db), db.select().from(invProductSettings).where(eq(invProductSettings.shopId, shopId))]);
  const ps = new Map(prodSettings.map((s) => [s.shopProductId, s.lastPurchaseRatePaise ?? 0]));
  let cogs = 0;
  let writeOff = 0;
  let opening = 0;
  let closing = 0;
  for (const [listingId, rows] of groupBy(ledger, (r) => r.shopProductId)) {
    const all = asEntries(rows);
    const v = valueStock(all, settings.valuationMethod, ps.get(listingId) ?? 0);
    for (const r of rows) {
      if (r.entryDate < from || r.entryDate >= to || r.qtyMilli >= 0) continue;
      const cost = v.outCost.get(r.id) ?? 0;
      if (r.movementType === "SALE") cogs += cost;
      else if (r.movementType === "WRITE_OFF_DAMAGE" || r.movementType === "WRITE_OFF_EXPIRY") writeOff += cost;
    }
    // A sale returned (cancellation restock) puts its cost back.
    for (const r of rows) {
      if (r.movementType === "SALE_RETURN" && r.entryDate >= from && r.entryDate < to) cogs -= Math.round((r.qtyMilli * (r.unitCostPaise ?? (v.unitCostPaise || (ps.get(listingId) ?? 0)))) / 1000);
    }
    opening += valueStock(all.filter((e) => e.entryDate < from), settings.valuationMethod, ps.get(listingId) ?? 0).valuePaise;
    closing += valueStock(all.filter((e) => e.entryDate < to), settings.valuationMethod, ps.get(listingId) ?? 0).valuePaise;
  }
  return { cogsPaise: cogs, writeOffPaise: writeOff, openingValuePaise: opening, closingValuePaise: closing };
}

export interface LedgerLine {
  id: string;
  entryDate: string;
  createdAt: Date;
  channel: "ONLINE" | "OFFLINE";
  movementType: StockMovementType;
  qtyMilli: number;
  balanceMilli: number;
  unitCostPaise: number | null;
  docRef: string | null;
  sourceType: StockSourceType;
  sourceId: string | null;
  orderId: string | null;
  note: string | null;
  createdBy: string | null;
  batchNo: string | null;
}

/** One listing's movements with the running balance, newest first. */
export async function listingLedger(shopId: string, shopProductId: string, limit = 200): Promise<LedgerLine[]> {
  const rows = await db
    .select({ l: invStockLedger, batchNo: invBatches.batchNo })
    .from(invStockLedger)
    .leftJoin(invBatches, eq(invStockLedger.batchId, invBatches.id))
    .where(and(eq(invStockLedger.shopId, shopId), eq(invStockLedger.shopProductId, shopProductId)))
    .orderBy(asc(invStockLedger.createdAt), asc(invStockLedger.id));
  let balance = 0;
  const out = rows.map(({ l, batchNo }) => {
    balance += l.qtyMilli;
    return {
      id: l.id,
      entryDate: l.entryDate,
      createdAt: l.createdAt,
      channel: l.channel,
      movementType: l.movementType,
      qtyMilli: l.qtyMilli,
      balanceMilli: balance,
      unitCostPaise: l.unitCostPaise,
      docRef: l.docRef,
      sourceType: l.sourceType,
      sourceId: l.sourceId,
      orderId: l.orderId,
      note: l.note,
      createdBy: l.createdBy,
      batchNo,
    };
  });
  return out.reverse().slice(0, limit);
}

/** Listings whose count disagrees with the ledger — expected empty. */
export async function ledgerDrift(shopId: string): Promise<{ shopProductId: string; channel: string; ledgerUnits: number; stockUnits: number }[]> {
  const rows = await db.execute<{ shop_product_id: string; channel: string; ledger_units: number; stock_units: number }>(sql`
    SELECT sp.id AS shop_product_id, c.channel,
           floor(coalesce(sum(l.qty_milli), 0) / 1000.0)::int AS ledger_units,
           CASE WHEN c.channel = 'ONLINE' THEN sp.online_stock ELSE sp.offline_stock END AS stock_units
      FROM shop_products sp
      CROSS JOIN (VALUES ('ONLINE'), ('OFFLINE')) AS c(channel)
      LEFT JOIN inv_stock_ledger l ON l.shop_product_id = sp.id AND l.channel = c.channel
     WHERE sp.shop_id = ${shopId}
     GROUP BY sp.id, c.channel, sp.online_stock, sp.offline_stock
    HAVING floor(coalesce(sum(l.qty_milli), 0) / 1000.0)::int <> CASE WHEN c.channel = 'ONLINE' THEN sp.online_stock ELSE sp.offline_stock END
  `);
  return [...rows].map((r) => ({ shopProductId: r.shop_product_id, channel: r.channel, ledgerUnits: Number(r.ledger_units), stockUnits: Number(r.stock_units) }));
}

/* ------------------------------------------------------- owner actions */

export interface WriteOffInput {
  shopProductId: string;
  qtyMilli: number;
  kind: "DAMAGE" | "EXPIRY";
  batchId?: string | null;
  note?: string | null;
  entryDate?: string;
}

/** Damaged or expired goods leave the stock at their cost; the P&L shows them as written off. */
export async function writeOffStock(shopId: string, input: WriteOffInput, actorId: string): Promise<string> {
  if (!Number.isInteger(input.qtyMilli) || input.qtyMilli <= 0) throw validationFailed("Enter how much to write off.");
  return db.transaction(async (tx) => {
    const settings = await getSettings(shopId, tx);
    const have = await channelTotal(input.shopProductId, settings.purchaseChannel, tx);
    const other = settings.purchaseChannel === "ONLINE" ? "OFFLINE" : "ONLINE";
    const haveOther = await channelTotal(input.shopProductId, other, tx);
    if (input.qtyMilli > have + haveOther) throw validationFailed(`Only ${(have + haveOther) / 1000} in stock.`);
    // Take from the purchase channel first, then the other.
    const first = Math.min(input.qtyMilli, Math.max(have, 0));
    const postings: StockPosting[] = [];
    const base = { shopId, shopProductId: input.shopProductId, movementType: input.kind === "DAMAGE" ? "WRITE_OFF_DAMAGE" : "WRITE_OFF_EXPIRY", sourceType: "MANUAL", batchId: input.batchId ?? null, note: input.note ?? null, entryDate: input.entryDate, createdBy: actorId } as const;
    if (first > 0) postings.push({ ...base, channel: settings.purchaseChannel, qtyMilli: -first });
    if (input.qtyMilli - first > 0) postings.push({ ...base, channel: other, qtyMilli: -(input.qtyMilli - first) });
    const ids = await postStock(postings, tx);
    await logChange({ shopId, entityType: "stock", entityId: input.shopProductId, action: base.movementType, changes: [{ field: "qtyMilli", old: null, new: -input.qtyMilli }], reason: input.note ?? null, actorId }, tx);
    return ids[0];
  });
}

/** Physical count: sets the stock to what is on the shelf (difference posted as an adjustment). */
export async function adjustStockTo(shopId: string, shopProductId: string, countedMilli: number, note: string | null, actorId: string): Promise<{ deltaMilli: number }> {
  if (!Number.isInteger(countedMilli) || countedMilli < 0) throw validationFailed("Enter the quantity counted (0 or more).");
  return db.transaction(async (tx) => {
    const settings = await getSettings(shopId, tx);
    const other = settings.purchaseChannel === "ONLINE" ? "OFFLINE" : "ONLINE";
    const main = await channelTotal(shopProductId, settings.purchaseChannel, tx);
    const second = await channelTotal(shopProductId, other, tx);
    const delta = countedMilli - (main + second);
    if (delta === 0) return { deltaMilli: 0 };
    const postings: StockPosting[] = [];
    const base = { shopId, shopProductId, movementType: "ADJUSTMENT", sourceType: "MANUAL", note: note ?? "Physical stock count", createdBy: actorId } as const;
    if (delta > 0 || -delta <= Math.max(main, 0)) postings.push({ ...base, channel: settings.purchaseChannel, qtyMilli: delta });
    else {
      const fromMain = Math.max(main, 0);
      if (fromMain > 0) postings.push({ ...base, channel: settings.purchaseChannel, qtyMilli: -fromMain });
      postings.push({ ...base, channel: other, qtyMilli: delta + fromMain });
    }
    await postStock(postings, tx);
    await logChange({ shopId, entityType: "stock", entityId: shopProductId, action: "COUNT", changes: [{ field: "qtyMilli", old: main + second, new: countedMilli }], reason: note, actorId }, tx);
    return { deltaMilli: delta };
  });
}

/** Turns batch / expiry tracking on or off for a listing. */
export async function setTrackBatches(shopId: string, shopProductId: string, track: boolean): Promise<void> {
  const [sp] = await db.select({ shopId: shopProducts.shopId }).from(shopProducts).where(eq(shopProducts.id, shopProductId));
  if (!sp || sp.shopId !== shopId) throw notFound("Product");
  await upsertRow(db, invProductSettings, { keys: [invProductSettings.shopProductId], values: { shopProductId, shopId, trackBatches: track }, set: { trackBatches: track, updatedAt: new Date() } });
}

export interface ExpiringBatch {
  batchId: string;
  shopProductId: string;
  name: string;
  batchNo: string;
  expiryDate: string;
  qtyMilli: number;
  expired: boolean;
}

/** Batches still in stock that expire within `days` (or have expired). */
export async function expiringBatches(shopId: string, days?: number): Promise<ExpiringBatch[]> {
  const settings = await getSettings(shopId);
  const window = days ?? settings.expiryAlertDays;
  const today = todayIst();
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + window);
  const until = limit.toISOString().slice(0, 10);
  const batches = await db
    .select({ b: invBatches, name: products.name })
    .from(invBatches)
    .innerJoin(shopProducts, eq(invBatches.shopProductId, shopProducts.id))
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .where(and(eq(invBatches.shopId, shopId), lte(invBatches.expiryDate, until)));
  if (batches.length === 0) return [];
  const ledger = await ledgerFor(shopId, null, db);
  const out: ExpiringBatch[] = [];
  for (const [listingId, rows] of groupBy(ledger, (r) => r.shopProductId)) {
    const listingBatches = batches.filter((b) => b.b.shopProductId === listingId);
    if (listingBatches.length === 0) continue;
    const allBatches = await db.select().from(invBatches).where(eq(invBatches.shopProductId, listingId));
    const inbound = rows.filter((e) => e.batchId && e.qtyMilli > 0).map((e) => ({ batchId: e.batchId!, qtyMilli: e.qtyMilli, expiryDate: allBatches.find((b) => b.id === e.batchId)?.expiryDate ?? null }));
    const batchedOut = rows.filter((e) => e.batchId && e.qtyMilli < 0);
    for (const o of batchedOut) {
      const i = inbound.find((x) => x.batchId === o.batchId);
      if (i) i.qtyMilli += o.qtyMilli;
    }
    // Sales from orders name no batch: they are taken from the batch expiring first.
    const outUnbatched = -rows.filter((e) => !e.batchId && e.qtyMilli < 0).reduce((n, e) => n + e.qtyMilli, 0);
    const left = batchBalances(inbound, outUnbatched);
    for (const { b, name } of listingBatches) {
      const qty = left.get(b.id) ?? 0;
      if (qty > 0 && b.expiryDate) out.push({ batchId: b.id, shopProductId: listingId, name, batchNo: b.batchNo, expiryDate: b.expiryDate, qtyMilli: qty, expired: b.expiryDate < today });
    }
  }
  return out.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
}
