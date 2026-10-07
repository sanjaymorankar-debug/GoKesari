/**
 * Shop offers (feature F8).
 *
 * A shop owner's own discount on one product or a whole category, live
 * between its start and end. With rule "shopOffers" on, live offers show on
 * the shop page and reduce the unit price in the cart and at checkout — the
 * same function prices both, so what the customer sees is what they pay. When
 * several offers match, the lowest resulting price wins. Loose goods with no
 * price are never discounted, and a price never drops below ₹0.01.
 */
import { and, asc, desc, eq, gt, inArray, lte } from "drizzle-orm";

import { notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import { productCategories, products, shopOffers, shopProducts, type ShopOffer } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { getRule } from "./settings";

export type OfferPricingTarget = { shopId: string; shopProductId: string; categoryId: string };

/** Live offers for these shops (none when the rule is off). */
export async function getLiveOffers(shopIds: string[], now: Date = new Date(), client: DbClient = db): Promise<ShopOffer[]> {
  if (shopIds.length === 0 || !(await getRule("shopOffers")).enabled) return [];
  return client
    .select()
    .from(shopOffers)
    .where(
      and(
        inArray(shopOffers.shopId, [...new Set(shopIds)]),
        eq(shopOffers.active, true),
        lte(shopOffers.startsAt, now),
        gt(shopOffers.endsAt, now),
      ),
    );
}

export function offerUnitPrice(offer: Pick<ShopOffer, "discountType" | "percent" | "flatPaise">, listPaise: number): number {
  const off = offer.discountType === "PERCENT" ? Math.floor((listPaise * (offer.percent ?? 0)) / 100) : (offer.flatPaise ?? 0);
  return Math.max(1, listPaise - off);
}

/** The best live offer price for one shop product, or the list price unchanged. */
export function priceWithOffers(
  listPaise: number | null,
  target: OfferPricingTarget,
  offers: ShopOffer[],
): { unitPricePaise: number | null; offer: ShopOffer | null } {
  if (listPaise == null || listPaise <= 0) return { unitPricePaise: listPaise, offer: null };
  let best: { unitPricePaise: number; offer: ShopOffer | null } = { unitPricePaise: listPaise, offer: null };
  for (const o of offers) {
    if (o.shopId !== target.shopId) continue;
    const matches =
      (o.targetType === "PRODUCT" && o.shopProductId === target.shopProductId) ||
      (o.targetType === "CATEGORY" && o.categoryId === target.categoryId);
    if (!matches) continue;
    const price = offerUnitPrice(o, listPaise);
    if (price < best.unitPricePaise) best = { unitPricePaise: price, offer: o };
  }
  return best;
}

/* ------------------------------------------------------------ public */

/** Live offers with what they apply to, for the shop page. */
export async function listLiveOffersForShop(shopId: string) {
  const offers = await getLiveOffers([shopId]);
  if (offers.length === 0) return [];
  const productNames = await namesForShopProducts(offers.map((o) => o.shopProductId));
  const categoryNames = await namesForCategories(offers.map((o) => o.categoryId));
  return offers
    .sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime())
    .map((o) => ({
      id: o.id,
      title: o.title,
      appliesTo: o.targetType === "PRODUCT" ? (productNames.get(o.shopProductId!) ?? "a product") : `all ${categoryNames.get(o.categoryId!) ?? "items in a category"}`,
      label: o.discountType === "PERCENT" ? `${o.percent}% off` : `₹${((o.flatPaise ?? 0) / 100).toFixed(0)} off each`,
      endsAt: o.endsAt,
    }));
}

async function namesForShopProducts(ids: (string | null)[]) {
  const list = ids.filter((id): id is string => id != null);
  if (list.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: shopProducts.id, name: products.name })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(inArray(shopProducts.id, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function namesForCategories(ids: (string | null)[]) {
  const list = ids.filter((id): id is string => id != null);
  if (list.length === 0) return new Map<string, string>();
  const rows = await db.select({ id: productCategories.id, name: productCategories.name }).from(productCategories).where(inArray(productCategories.id, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/* --------------------------------------------------------- shop owner */

export interface ShopOfferInput {
  title: string;
  targetType: "PRODUCT" | "CATEGORY";
  shopProductId?: string | null;
  categoryId?: string | null;
  discountType: "PERCENT" | "FLAT";
  percent?: number | null;
  flatPaise?: number | null;
  startsAt: Date;
  endsAt: Date;
  active?: boolean;
}

export async function listShopOffers(shopId: string) {
  const offers = await db.select().from(shopOffers).where(eq(shopOffers.shopId, shopId)).orderBy(desc(shopOffers.createdAt));
  const productNames = await namesForShopProducts(offers.map((o) => o.shopProductId));
  const categoryNames = await namesForCategories(offers.map((o) => o.categoryId));
  return offers.map((o) => ({
    ...o,
    targetName: o.targetType === "PRODUCT" ? (productNames.get(o.shopProductId!) ?? "") : (categoryNames.get(o.categoryId!) ?? ""),
  }));
}

/** Products and categories the shop sells, for the offer form. */
export async function offerTargetsForShop(shopId: string) {
  const rows = await db
    .select({ id: shopProducts.id, name: products.name, categoryId: products.categoryId, categoryName: productCategories.name })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
    .where(eq(shopProducts.shopId, shopId))
    .orderBy(asc(products.name));
  const categories = new Map<string, string>();
  for (const r of rows) categories.set(r.categoryId, r.categoryName);
  return {
    products: rows.map((r) => ({ id: r.id, name: r.name })),
    categories: [...categories].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function saveShopOffer(shopId: string, input: ShopOfferInput, actor: { id: string; role: string }, id?: string) {
  const title = input.title.trim();
  if (title.length < 3 || title.length > 80) throw validationFailed("Give the offer a title of 3–80 characters.");
  if (input.discountType === "PERCENT" && !(input.percent && input.percent >= 1 && input.percent <= 90)) {
    throw validationFailed("Percent off must be between 1 and 90.");
  }
  if (input.discountType === "FLAT" && !(input.flatPaise && input.flatPaise > 0)) throw validationFailed("Enter the amount off each item.");
  if (!(input.endsAt > input.startsAt)) throw validationFailed("The offer must end after it starts.");

  let shopProductId: string | null = null;
  let categoryId: string | null = null;
  if (input.targetType === "PRODUCT") {
    const sp = input.shopProductId ? await db.query.shopProducts.findFirst({ where: eq(shopProducts.id, input.shopProductId) }) : null;
    if (!sp || sp.shopId !== shopId) throw validationFailed("Choose one of your own products.");
    shopProductId = sp.id;
  } else {
    const targets = await offerTargetsForShop(shopId);
    if (!input.categoryId || !targets.categories.some((c) => c.id === input.categoryId)) {
      throw validationFailed("Choose a category your shop sells.");
    }
    categoryId = input.categoryId;
  }

  const values = {
    shopId,
    title,
    targetType: input.targetType,
    shopProductId,
    categoryId,
    discountType: input.discountType,
    percent: input.discountType === "PERCENT" ? input.percent! : null,
    flatPaise: input.discountType === "FLAT" ? input.flatPaise! : null,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    active: input.active ?? true,
    updatedAt: new Date(),
  };
  let row: ShopOffer | undefined;
  if (id) {
    [row] = await db.update(shopOffers).set(values).where(and(eq(shopOffers.id, id), eq(shopOffers.shopId, shopId))).returning();
    if (!row) throw notFound("Offer");
  } else {
    [row] = await db.insert(shopOffers).values({ ...values, createdBy: actor.id }).returning();
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role as never,
    action: AUDIT_ACTIONS.SHOP_OFFER_SAVED,
    entityType: "shop_offer",
    entityId: row.id,
    newValue: values,
  });
  return row;
}
