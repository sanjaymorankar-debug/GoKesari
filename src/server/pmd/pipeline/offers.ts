/**
 * Offers (PRODUCT_SELLER) and price history.
 *
 * One product_offer row is the CURRENT state of one seller's offer on one source
 * listing; price_history is the append-only record of how it changed. Prices are
 * never product attributes - a price change writes a history row and updates the
 * offer, and never touches product_master.
 *
 * Rules:
 *   first sighting           -> offer row + history row (FIRST_SEEN)
 *   same seller, new price   -> offer updated + history row (PRICE_CHANGED ...)
 *   same seller, no change   -> only last_seen / collected_at move; no history row
 *   new seller               -> a new offer row (the same product, one more seller)
 *   older-than-current data  -> never overwrites current state; backfills history once
 */
import type { Queryable } from "../db";
import type { NormalizedOffer } from "../types";

export interface OfferOutcome {
  kind: "INSERTED" | "PRICE_CHANGED" | "UNCHANGED" | "BACKFILLED" | "STALE_IGNORED";
  offerId: number;
  historyRows: number;
  /** Set when a new price is implausibly far from the previous one. The price is still recorded (history keeps everything); a person is told. */
  outlier?: { previousMinor: number; nextMinor: number };
}

/** A move of 5x or more in either direction between two observations of one seller's price. */
export const PRICE_OUTLIER_RATIO = 5;

export function isPriceOutlier(previousMinor: number | null, nextMinor: number | null): boolean {
  if (!previousMinor || !nextMinor || previousMinor <= 0 || nextMinor <= 0) return false;
  const ratio = nextMinor / previousMinor;
  return ratio >= PRICE_OUTLIER_RATIO || ratio <= 1 / PRICE_OUTLIER_RATIO;
}

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

type Reason = "FIRST_SEEN" | "PRICE_CHANGED" | "MRP_CHANGED" | "STOCK_CHANGED" | "PRICE_AND_STOCK_CHANGED";

function discountOf(o: NormalizedOffer): { minor: number | null; pct: number | null } {
  if (o.priceMinor != null && o.mrpMinor != null && o.mrpMinor > 0 && o.mrpMinor >= o.priceMinor) {
    const minor = o.mrpMinor - o.priceMinor;
    return { minor, pct: Math.round((10000 * minor) / o.mrpMinor) / 100 };
  }
  return { minor: null, pct: null };
}

async function insertHistory(
  sql: Queryable,
  args: { productId: number; offerId: number; sourceId: number; o: NormalizedOffer; reason: Reason; runId: number },
): Promise<void> {
  const { productId, offerId, sourceId, o, reason, runId } = args;
  const d = discountOf(o);
  await sql`
    INSERT INTO pmd.price_history
      (product_id, offer_id, source_id, seller_key, seller_name, mrp_minor, selling_price_minor, discount_minor, currency,
       stock_status, change_reason, collection_date, collected_at, run_id)
    VALUES (${productId}, ${offerId}, ${sourceId}, ${o.sellerKey}, ${o.sellerName}, ${o.mrpMinor}, ${o.priceMinor}, ${d.minor},
            ${o.currency}, ${o.stockStatus}, ${reason}, ${dateOnly(o.collectedAt)}, ${o.collectedAt}, ${runId})`;
}

export async function applyOffer(
  sql: Queryable,
  args: {
    productSourceId: number;
    productId: number;
    sourceId: number;
    sourceProductId: string;
    sourceUrl: string | null;
    runId: number;
    offer: NormalizedOffer;
  },
): Promise<OfferOutcome> {
  const { productSourceId, productId, sourceId, sourceProductId, runId, offer: o } = args;
  const d = discountOf(o);

  const [existing] = await sql<
    { offer_id: number; price_minor: number | null; mrp_minor: number | null; stock_status: string; currency: string; collected_at: Date }[]
  >`SELECT offer_id, price_minor, mrp_minor, stock_status, currency, collected_at
      FROM pmd.product_offer WHERE product_source_id = ${productSourceId} AND seller_key = ${o.sellerKey} FOR UPDATE`;

  if (!existing) {
    const [row] = await sql<{ offer_id: number }[]>`
      INSERT INTO pmd.product_offer
        (product_source_id, product_id, source_id, source_product_id, seller_key, seller_id, seller_name, seller_location, seller_rating,
         price_minor, mrp_minor, discount_minor, discount_pct, currency, tax_inclusive, stock_status, delivery_information, source_url,
         first_seen_at, last_seen_at, collection_date, collected_at, is_current)
      VALUES (${productSourceId}, ${productId}, ${sourceId}, ${sourceProductId}, ${o.sellerKey}, ${o.sellerId}, ${o.sellerName}, ${o.sellerLocation}, ${o.sellerRating},
              ${o.priceMinor}, ${o.mrpMinor}, ${d.minor}, ${d.pct}, ${o.currency}, ${o.taxInclusive}, ${o.stockStatus}, ${o.deliveryInformation}, ${o.url ?? args.sourceUrl},
              now(), now(), ${dateOnly(o.collectedAt)}, ${o.collectedAt}, true)
      RETURNING offer_id`;
    await insertHistory(sql, { productId, offerId: row.offer_id, sourceId, o, reason: "FIRST_SEEN", runId });
    return { kind: "INSERTED", offerId: row.offer_id, historyRows: 1 };
  }

  // An observation older than what we already hold must not roll the current state back.
  if (o.collectedAt.getTime() < existing.collected_at.getTime()) {
    const [have] = await sql`SELECT 1 FROM pmd.price_history WHERE offer_id = ${existing.offer_id} AND collected_at = ${o.collectedAt} LIMIT 1`;
    if (have) return { kind: "STALE_IGNORED", offerId: existing.offer_id, historyRows: 0 };
    await insertHistory(sql, { productId, offerId: existing.offer_id, sourceId, o, reason: "FIRST_SEEN", runId });
    return { kind: "BACKFILLED", offerId: existing.offer_id, historyRows: 1 };
  }

  const priceChanged = existing.price_minor !== o.priceMinor || existing.currency !== o.currency;
  const mrpChanged = existing.mrp_minor !== o.mrpMinor;
  const stockChanged = existing.stock_status !== o.stockStatus;

  if (!priceChanged && !mrpChanged && !stockChanged) {
    await sql`
      UPDATE pmd.product_offer
         SET last_seen_at = now(), is_current = true, product_id = ${productId},
             collected_at = ${o.collectedAt}, collection_date = ${dateOnly(o.collectedAt)}
       WHERE offer_id = ${existing.offer_id}`;
    return { kind: "UNCHANGED", offerId: existing.offer_id, historyRows: 0 };
  }

  await sql`
    UPDATE pmd.product_offer SET
      product_id = ${productId}, price_minor = ${o.priceMinor}, mrp_minor = ${o.mrpMinor}, discount_minor = ${d.minor},
      discount_pct = ${d.pct}, currency = ${o.currency}, stock_status = ${o.stockStatus}, tax_inclusive = ${o.taxInclusive},
      seller_name = COALESCE(${o.sellerName}, seller_name), seller_location = COALESCE(${o.sellerLocation}, seller_location),
      seller_rating = COALESCE(${o.sellerRating}, seller_rating), delivery_information = COALESCE(${o.deliveryInformation}, delivery_information),
      last_seen_at = now(), collected_at = ${o.collectedAt}, collection_date = ${dateOnly(o.collectedAt)}, is_current = true
    WHERE offer_id = ${existing.offer_id}`;

  const reason: Reason =
    (priceChanged || mrpChanged) && stockChanged ? "PRICE_AND_STOCK_CHANGED" : priceChanged ? "PRICE_CHANGED" : mrpChanged ? "MRP_CHANGED" : "STOCK_CHANGED";
  await insertHistory(sql, { productId, offerId: existing.offer_id, sourceId, o, reason, runId });
  const outlier = priceChanged && isPriceOutlier(existing.price_minor, o.priceMinor)
    ? { previousMinor: existing.price_minor!, nextMinor: o.priceMinor! }
    : undefined;
  return { kind: "PRICE_CHANGED", offerId: existing.offer_id, historyRows: 1, ...(outlier ? { outlier } : {}) };
}

/**
 * After a COMPLETE snapshot of a source, offers it no longer lists are marked not current
 * and a history row records the loss. Absence from one marketplace only ever downgrades
 * an offer: it can never mark a product DISCONTINUED.
 */
export async function markUnseenOffers(sql: Queryable, sourceId: number, seenBefore: Date, runId: number): Promise<number[]> {
  const gone = await sql<
    { offer_id: number; product_id: number | null; seller_key: string; seller_name: string | null; mrp_minor: number | null; price_minor: number | null; currency: string }[]
  >`UPDATE pmd.product_offer SET is_current = false
     WHERE source_id = ${sourceId} AND is_current AND last_seen_at < ${seenBefore}
     RETURNING offer_id, product_id, seller_key, seller_name, mrp_minor, price_minor, currency`;
  const productIds = new Set<number>();
  for (const g of gone) {
    if (g.product_id == null) continue;
    productIds.add(g.product_id);
    await sql`
      INSERT INTO pmd.price_history
        (product_id, offer_id, source_id, seller_key, seller_name, mrp_minor, selling_price_minor, currency, stock_status, change_reason, collection_date, collected_at, run_id)
      VALUES (${g.product_id}, ${g.offer_id}, ${sourceId}, ${g.seller_key}, ${g.seller_name}, ${g.mrp_minor}, ${g.price_minor}, ${g.currency},
              'UNKNOWN', 'STOCK_CHANGED', current_date, now(), ${runId})`;
  }
  return [...productIds];
}

/**
 * Derives product_status from current offers. DISCONTINUED is never derived: a product
 * missing from one marketplace is not discontinued, so only a person or a manufacturer
 * statement may set it (and it is then left alone here).
 */
export async function recomputeProductStatus(sql: Queryable, productIds: number[]): Promise<void> {
  if (productIds.length === 0) return;
  await sql`
    UPDATE pmd.product_master pm SET
      product_status = d.status, status_basis = d.basis, status_updated_at = now()
    FROM (
      SELECT p.product_id,
        CASE
          WHEN a.in_stock > 0 THEN 'ACTIVE'
          WHEN a.current_offers > 0 AND a.out_of_stock = a.current_offers THEN 'OUT_OF_STOCK'
          WHEN a.current_offers = 0 AND a.any_offers > 0 THEN 'TEMPORARILY_UNAVAILABLE'
          ELSE 'UNKNOWN' END AS status,
        CASE
          WHEN a.in_stock > 0 THEN 'IN_STOCK_OFFER'
          WHEN a.current_offers > 0 AND a.out_of_stock = a.current_offers THEN 'ALL_OFFERS_OUT_OF_STOCK'
          WHEN a.current_offers = 0 AND a.any_offers > 0 THEN 'NO_CURRENT_OFFERS'
          WHEN a.current_offers > 0 THEN 'NO_STOCK_SIGNAL'
          ELSE 'NO_OFFERS' END AS basis
      FROM pmd.product_master p
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE is_current) AS current_offers,
               count(*) FILTER (WHERE is_current AND stock_status IN ('IN_STOCK','LIMITED')) AS in_stock,
               count(*) FILTER (WHERE is_current AND stock_status = 'OUT_OF_STOCK') AS out_of_stock,
               count(*) AS any_offers
        FROM pmd.product_offer o WHERE o.product_id = p.product_id
      ) a ON true
      WHERE p.product_id IN ${sql(productIds)}
    ) d
    WHERE pm.product_id = d.product_id AND pm.product_status <> 'DISCONTINUED'
      AND (pm.product_status <> d.status OR pm.status_basis IS DISTINCT FROM d.basis)`;
}
