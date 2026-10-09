/**
 * Items pulled from a shop's software into GoKesari (Module 2).
 *
 * 1. Every item is recorded (integration_item_links) with what the software
 *    said, so the mapping screen and the error screen can show it.
 * 2. Items not yet matched are matched automatically: barcode/GTIN, then
 *    GoKesari product code (SKU), then name (trigram similarity — a very close
 *    name among the shop's own products is matched, anything less is only
 *    suggested for the owner to confirm). Manual matches and "ignore" are
 *    never overwritten.
 * 3. For matched items the software is the source of truth for stock and
 *    price (conflict rule): the shop's listing takes them, through the same
 *    updateShopProduct the owner's own edits use (price history, stock ledger,
 *    MRP check). GoKesari stays the source of truth for online orders: online
 *    stock = the software's stock minus units in open online orders not yet
 *    invoiced to it, so a pull never resells goods already sold online.
 *    A price above the verified MRP is not applied (lastIssue PRICE_ABOVE_MRP).
 *    A first price puts a listing on sale (loose goods get their price this way).
 *    HSN and GST rate go on the listing (the shop's own classification).
 *    A matched product the shop does not list yet is added — only if the shop
 *    carries its category (adding a category would fill the whole category).
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { AppError } from "@/lib/errors";
import { db } from "@/server/db";
import {
  integrationItemLinks,
  integrationJobs,
  orderItems,
  orders,
  products,
  shopProducts,
  shops,
  taxInvoices,
  type IntegrationItemLink,
  type ShopIntegration,
  type ShopProduct,
} from "@/server/db/schema";
import { createShopProduct, updateShopProduct } from "@/server/services/catalogue";
import { OPEN_ORDER_STATUSES } from "@/server/services/inventory-alerts";
import { canonicalItem, type CanonicalItem } from "./canonical";
import { logSync } from "./jobs";

export interface PullOptions {
  stock: boolean;
  price: boolean;
  tax: boolean;
  /** Which GoKesari price the software's selling price sets. */
  priceChannels: "BOTH" | "ONLINE";
  /** Which GoKesari stock the software's stock sets. */
  stockTo: "ONLINE" | "BOTH";
}

export function pullOptions(config: Record<string, unknown>): PullOptions {
  const pull = (config.pull ?? {}) as Partial<PullOptions>;
  return {
    stock: pull.stock !== false,
    price: pull.price !== false,
    tax: pull.tax !== false,
    priceChannels: pull.priceChannels === "ONLINE" ? "ONLINE" : "BOTH",
    stockTo: pull.stockTo === "BOTH" ? "BOTH" : "ONLINE",
  };
}

export interface PullSummary {
  seen: number;
  invalid: number;
  matched: number;
  suggested: number;
  unmatched: number;
  ignored: number;
  applied: number;
  unchanged: number;
  issues: number;
}

/* -------------------------------------------------------------- matching */

interface MatchResult {
  status: IntegrationItemLink["matchStatus"];
  method: IntegrationItemLink["matchMethod"];
  productId: string | null;
  suggestions: { productId: string; name: string; score: number }[];
}

export async function autoMatch(shopId: string, item: CanonicalItem): Promise<MatchResult> {
  const none: MatchResult = { status: "UNMATCHED", method: null, productId: null, suggestions: [] };
  const digits = item.barcode?.replace(/[\s-]/g, "") ?? "";
  if (/^\d{8,14}$/.test(digits)) {
    const rows = await db
      .select({ id: products.id })
      .from(products)
      .where(and(isNull(products.deletedAt), sql`(${products.gtin} = ${digits} OR ${products.barcode} = ${item.barcode!.trim()})`))
      .limit(2);
    if (rows.length === 1) return { status: "MATCHED", method: "BARCODE", productId: rows[0].id, suggestions: [] };
  }
  if (item.sku?.trim()) {
    const [row] = await db
      .select({ id: products.id })
      .from(products)
      .where(and(isNull(products.deletedAt), eq(products.code, item.sku.trim().toUpperCase())));
    if (row) return { status: "MATCHED", method: "SKU", productId: row.id, suggestions: [] };
  }
  const name = item.name.trim().toLowerCase();
  if (name.length < 3) return none;
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      score: sql<number>`similarity(lower(${products.name}), ${name})`,
      listed: sql<boolean>`exists (select 1 from ${shopProducts} sp where sp.product_id = ${products.id} and sp.shop_id = ${shopId} and sp.deleted_at is null)`,
    })
    .from(products)
    .where(and(isNull(products.deletedAt), sql`similarity(lower(${products.name}), ${name}) > 0.45`))
    // The shop's own products first, then by similarity.
    .orderBy(sql`4 DESC`, sql`3 DESC`)
    .limit(5);
  if (rows.length === 0) return none;
  const suggestions = rows.map((r) => ({ productId: r.id, name: r.name, score: Math.round(Number(r.score) * 100) / 100 }));
  const best = rows[0];
  // Only an almost identical name among the shop's own products is matched without the owner.
  if (best.listed && Number(best.score) >= 0.9 && (rows.length === 1 || Number(rows[1].score) < Number(best.score) - 0.1)) {
    return { status: "MATCHED", method: "NAME", productId: best.id, suggestions };
  }
  return { status: "SUGGESTED", method: null, productId: null, suggestions };
}

/* -------------------------------------------------------------- applying */

/**
 * Units of a listing GoKesari has sold that the shop's software does not know
 * about yet: open online orders (checkout already took them off online stock)
 * and delivered orders whose invoice has not reached the software.
 */
async function reservedUnits(integrationId: string, listing: ShopProduct): Promise<number> {
  const [row] = await db
    .select({
      milli: sql<number>`coalesce(sum(${orderItems.quantityMilli}), 0)::bigint`,
      size: products.unitSizeMilli,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(products, eq(products.id, listing.productId))
    .where(
      and(
        eq(orderItems.shopProductId, listing.id),
        or(
          inArray(orders.status, [...OPEN_ORDER_STATUSES]),
          and(
            eq(orders.status, "DELIVERED"),
            sql`exists (select 1 from ${taxInvoices} ti join ${integrationJobs} ij on ij.subject_id = ti.id::text
                 where ti.order_id = ${orders.id} and ij.integration_id = ${integrationId}
                   and ij.kind = 'PUSH_INVOICE' and ij.status in ('PENDING', 'CLAIMED', 'FAILED', 'DEAD'))`,
          ),
        ),
      ),
    )
    .groupBy(products.unitSizeMilli);
  if (!row) return 0;
  return Math.round(Number(row.milli) / Math.max(1, row.size));
}

const rupees = (p: number) => `₹${(p / 100).toFixed(2)}`;

async function applyToListing(
  integrationId: string,
  shop: { id: string; ownerId: string },
  link: IntegrationItemLink,
  item: CanonicalItem,
  options: PullOptions,
): Promise<"applied" | "unchanged" | "issue"> {
  const owner = { id: shop.ownerId, role: "SHOP_OWNER" as const };
  const issues: string[] = [];
  let listing = link.shopProductId
    ? await db.query.shopProducts.findFirst({ where: and(eq(shopProducts.id, link.shopProductId), isNull(shopProducts.deletedAt)) })
    : undefined;
  if (!listing && link.productId) {
    listing = await db.query.shopProducts.findFirst({
      where: and(eq(shopProducts.shopId, shop.id), eq(shopProducts.productId, link.productId), isNull(shopProducts.deletedAt)),
    });
  }
  const price = options.price && item.pricePaise && item.pricePaise > 0 ? item.pricePaise : null;
  const stock = options.stock && item.stock != null ? Math.max(0, Math.floor(item.stock)) : null;

  if (!listing && link.productId) {
    try {
      listing = await createShopProduct(
        {
          shopId: shop.id,
          productId: link.productId,
          onlinePricePaise: price,
          offlinePricePaise: price && options.priceChannels === "BOTH" ? price : null,
          onlineSaleEnabled: price != null,
          offlineSaleEnabled: price != null && options.priceChannels === "BOTH",
          onlineStock: stock ?? 0,
          offlineStock: options.stockTo === "BOTH" ? (stock ?? 0) : 0,
        },
        owner,
      );
    } catch (error) {
      await db
        .update(integrationItemLinks)
        .set({ lastIssue: error instanceof Error ? error.message : "Could not add the product to the shop.", updatedAt: new Date() })
        .where(eq(integrationItemLinks.id, link.id));
      return "issue";
    }
  }
  if (!listing) return "unchanged";

  const patch: Parameters<typeof updateShopProduct>[1] = {};
  if (stock != null && listing.trackInventory) {
    const online = Math.max(0, stock - (await reservedUnits(integrationId, listing)));
    if (online !== listing.onlineStock) patch.onlineStock = online;
    if (options.stockTo === "BOTH" && stock !== listing.offlineStock) patch.offlineStock = stock;
  }
  const pricePatch: Parameters<typeof updateShopProduct>[1] = {};
  if (price != null) {
    if (price !== listing.onlinePricePaise) pricePatch.onlinePricePaise = price;
    if (options.priceChannels === "BOTH" && price !== listing.offlinePricePaise) pricePatch.offlinePricePaise = price;
    // A first price puts the product on sale, as when the owner sets it (loose goods start without one).
    if (listing.onlinePricePaise == null && listing.offlinePricePaise == null) {
      pricePatch.onlineSaleEnabled = true;
      if (options.priceChannels === "BOTH") pricePatch.offlineSaleEnabled = true;
    }
  }

  let changed = false;
  if (Object.keys(patch).length + Object.keys(pricePatch).length > 0) {
    try {
      await updateShopProduct(listing.id, { ...patch, ...pricePatch }, owner);
      changed = true;
    } catch (error) {
      // Usually the price is above the verified MRP: keep the stock, report the price.
      if (error instanceof AppError && Object.keys(pricePatch).length > 0) {
        issues.push(`Price ${rupees(price!)} not applied: ${error.message}`);
        if (Object.keys(patch).length > 0) {
          await updateShopProduct(listing.id, patch, owner);
          changed = true;
        }
      } else {
        throw error;
      }
    }
  }
  if (options.tax && (item.hsn || item.gstRateBp != null)) {
    const hsn = item.hsn ?? listing.hsnCode;
    const rate = item.gstRateBp ?? listing.gstRateBp;
    if (hsn !== listing.hsnCode || rate !== listing.gstRateBp) {
      await db.update(shopProducts).set({ hsnCode: hsn, gstRateBp: rate, updatedAt: new Date() }).where(eq(shopProducts.id, listing.id));
      changed = true;
    }
  }
  if (item.mrpPaise) {
    const [product] = await db.select({ mrp: products.mrpPaise }).from(products).where(eq(products.id, listing.productId));
    if (product?.mrp != null && product.mrp !== item.mrpPaise) {
      issues.push(`MRP in your software is ${rupees(item.mrpPaise)}; GoKesari has ${rupees(product.mrp)}. Report it from the product page if GoKesari's is wrong.`);
    }
  }
  await db.update(shopProducts).set({ externalSyncedAt: new Date() }).where(eq(shopProducts.id, listing.id));
  await db
    .update(integrationItemLinks)
    .set({
      shopProductId: listing.id,
      lastAppliedAt: new Date(),
      lastIssue: issues.length ? issues.join(" ") : null,
      updatedAt: new Date(),
    })
    .where(eq(integrationItemLinks.id, link.id));
  if (issues.length) return "issue";
  return changed ? "applied" : "unchanged";
}

const COMPARED: (keyof CanonicalItem)[] = ["name", "sku", "barcode", "unit", "stock", "pricePaise", "mrpPaise", "hsn", "gstRateBp", "cessBp"];

function sameItem(before: Record<string, unknown> | undefined, after: CanonicalItem): boolean {
  if (!before) return false;
  return COMPARED.every((k) => (before[k] ?? null) === (after[k] ?? null));
}

async function lastSeenOf(integrationId: string): Promise<Map<string, Record<string, unknown>>> {
  const rows = await db
    .select({ externalId: integrationItemLinks.externalId, lastSeen: integrationItemLinks.lastSeen })
    .from(integrationItemLinks)
    .where(eq(integrationItemLinks.integrationId, integrationId));
  return new Map(rows.map((r) => [r.externalId, r.lastSeen]));
}

/** Records, matches and applies a batch of items from the shop's software. */
export async function applyPulledItems(integration: ShopIntegration, rawItems: unknown[]): Promise<PullSummary> {
  const summary: PullSummary = { seen: 0, invalid: 0, matched: 0, suggested: 0, unmatched: 0, ignored: 0, applied: 0, unchanged: 0, issues: 0 };
  const [shop] = await db.select({ id: shops.id, ownerId: shops.ownerId }).from(shops).where(eq(shops.id, integration.shopId));
  if (!shop) return summary;
  const options = pullOptions(integration.config);
  const previous = await lastSeenOf(integration.id);
  for (const raw of rawItems) {
    const parsed = canonicalItem.safeParse(raw);
    if (!parsed.success) {
      summary.invalid += 1;
      continue;
    }
    const item = parsed.data;
    summary.seen += 1;
    const [link] = await db
      .insert(integrationItemLinks)
      .values({
        integrationId: integration.id,
        shopId: shop.id,
        externalId: item.externalId,
        externalName: item.name,
        externalSku: item.sku ?? null,
        externalBarcode: item.barcode ?? null,
        externalUnit: item.unit ?? null,
        lastSeen: item as unknown as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: [integrationItemLinks.integrationId, integrationItemLinks.externalId],
        set: {
          externalName: item.name,
          externalSku: item.sku ?? null,
          externalBarcode: item.barcode ?? null,
          externalUnit: item.unit ?? null,
          lastSeen: item as unknown as Record<string, unknown>,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();
    let current = link;
    // Same values as last time, already applied without a problem: nothing to do (Tally sends the whole list).
    if (link.matchStatus === "MATCHED" && link.lastAppliedAt && !link.lastIssue && sameItem(previous.get(item.externalId), item)) {
      summary.matched += 1;
      summary.unchanged += 1;
      continue;
    }
    if ((link.matchStatus === "UNMATCHED" || link.matchStatus === "SUGGESTED") && link.matchMethod !== "MANUAL") {
      const match = await autoMatch(shop.id, item);
      [current] = await db
        .update(integrationItemLinks)
        .set({ matchStatus: match.status, matchMethod: match.method, productId: match.productId, suggestions: match.suggestions, updatedAt: new Date() })
        .where(eq(integrationItemLinks.id, link.id))
        .returning();
    }
    if (current.matchStatus === "IGNORED") {
      summary.ignored += 1;
      continue;
    }
    if (current.matchStatus !== "MATCHED") {
      summary[current.matchStatus === "SUGGESTED" ? "suggested" : "unmatched"] += 1;
      continue;
    }
    summary.matched += 1;
    try {
      const outcome = await applyToListing(integration.id, shop, current, item, options);
      summary[outcome === "issue" ? "issues" : outcome] += 1;
    } catch (error) {
      summary.issues += 1;
      await db
        .update(integrationItemLinks)
        .set({ lastIssue: error instanceof Error ? error.message : String(error), updatedAt: new Date() })
        .where(eq(integrationItemLinks.id, current.id));
    }
  }
  const needsOwner = summary.suggested + summary.unmatched;
  await logSync(integration, {
    level: summary.issues > 0 ? "WARN" : "INFO",
    event: "pull.applied",
    message:
      `Items read: ${summary.seen}. Updated: ${summary.applied}, no change: ${summary.unchanged}` +
      (needsOwner ? `, ${needsOwner} need matching` : "") +
      (summary.issues ? `, ${summary.issues} with a problem` : "") +
      ".",
    detail: summary as unknown as Record<string, unknown>,
  });
  return summary;
}

/** Applies a link's last-seen values now (after the owner matches it by hand). */
export async function applyLinkNow(integration: ShopIntegration, linkId: string): Promise<"applied" | "unchanged" | "issue" | "skipped"> {
  const link = await db.query.integrationItemLinks.findFirst({
    where: and(eq(integrationItemLinks.id, linkId), eq(integrationItemLinks.integrationId, integration.id)),
  });
  if (!link || link.matchStatus !== "MATCHED") return "skipped";
  const parsed = canonicalItem.safeParse(link.lastSeen);
  if (!parsed.success) return "skipped";
  const [shop] = await db.select({ id: shops.id, ownerId: shops.ownerId }).from(shops).where(eq(shops.id, integration.shopId));
  if (!shop) return "skipped";
  try {
    return await applyToListing(integration.id, shop, link, parsed.data, pullOptions(integration.config));
  } catch (error) {
    await db
      .update(integrationItemLinks)
      .set({ lastIssue: error instanceof Error ? error.message : String(error), updatedAt: new Date() })
      .where(eq(integrationItemLinks.id, link.id));
    return "issue";
  }
}

/** Runs automatic matching again on every item not matched by hand (after products are added to GoKesari). */
export async function rematchLinks(integration: ShopIntegration): Promise<{ checked: number; matched: number; suggested: number }> {
  const links = await db
    .select()
    .from(integrationItemLinks)
    .where(and(eq(integrationItemLinks.integrationId, integration.id), inArray(integrationItemLinks.matchStatus, ["UNMATCHED", "SUGGESTED"])));
  const out = { checked: 0, matched: 0, suggested: 0 };
  for (const link of links) {
    if (link.matchMethod === "MANUAL") continue;
    const parsed = canonicalItem.safeParse(link.lastSeen);
    if (!parsed.success) continue;
    out.checked += 1;
    const match = await autoMatch(integration.shopId, parsed.data);
    await db
      .update(integrationItemLinks)
      .set({ matchStatus: match.status, matchMethod: match.method, productId: match.productId, suggestions: match.suggestions, updatedAt: new Date() })
      .where(eq(integrationItemLinks.id, link.id));
    if (match.status === "MATCHED") {
      out.matched += 1;
      await applyLinkNow(integration, link.id);
    } else if (match.status === "SUGGESTED") out.suggested += 1;
  }
  return out;
}
