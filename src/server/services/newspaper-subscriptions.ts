/**
 * Newspaper and periodical subscriptions (docs/newspaper-subscriptions-2026-11).
 *
 * The customer ticks the titles they want, chooses the delivery address, is
 * shown the nearby vendors who deliver there and carry those titles, picks
 * one and submits once. Each title becomes an ordinary subscription (the
 * engine in subscriptions.ts generates, charges, pauses and renews it), all
 * grouped by one bundle id; the vendor gets one notice and a subscriber list.
 *
 * A title is any live, approved, subscribable catalogue product that has a
 * `periodical_titles` row or sits in a category of the newspaper vendor shop
 * type — so a title a vendor or staff adds later appears too.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

import type { IsoDate } from "@/lib/dates";
import { MILLI_PER_UNIT } from "@/lib/money";
import {
  defaultScheduleFor,
  NEWSPAPER_VENDOR_SHOP_TYPE,
  type PeriodicalKind,
  type PeriodicalPublication,
  type SubscriptionFrequency,
  type SubscriptionSchedule,
} from "@/lib/periodicals";
import { notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  addresses,
  periodicalTitles,
  productCategories,
  products,
  shopProducts,
  subscriptions,
  users,
  type Subscription,
} from "@/server/db/schema";
import { locationFromAddress } from "@/server/location";
import { shopCarriesProductCategory } from "./product-categories";
import { listServiceableShops } from "./serviceability";
import { createSubscriptionGroup, DELIVERING_STATUSES } from "./subscriptions";

/* ------------------------------------------------------------- titles */

export interface PeriodicalTitleView {
  productId: string;
  name: string;
  kind: PeriodicalKind;
  language: string;
  publisher: string | null;
  publication: PeriodicalPublication;
  imageUrl: string | null;
  /** The schedule a new subscription starts with. */
  defaultSchedule: SubscriptionSchedule;
}

/** A category of the newspaper vendor type whose name says magazine/periodical holds magazines. */
const magazineCategory = sql<boolean>`(lower(${productCategories.name}) like '%magazine%' or lower(${productCategories.name}) like '%periodical%')`;

/** Live, approved, subscribable products that are newspapers or periodicals. */
function titleConditions() {
  return and(
    isNull(products.deletedAt),
    eq(products.isActive, true),
    eq(products.approvalStatus, "APPROVED"),
    eq(products.subscribable, true),
    or(isNotNull(periodicalTitles.productId), eq(productCategories.department, NEWSPAPER_VENDOR_SHOP_TYPE)),
  );
}

/** Every title, newspapers first, then by language and name. */
export async function listPeriodicalTitles(): Promise<PeriodicalTitleView[]> {
  const rows = await db
    .select({
      productId: products.id,
      name: products.name,
      imageUrl: products.imageUrl,
      title: periodicalTitles,
      magazineCategory,
    })
    .from(products)
    .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
    .leftJoin(periodicalTitles, eq(periodicalTitles.productId, products.id))
    .where(titleConditions())
    .orderBy(asc(products.name))
    .limit(2000);

  const views = rows.map((r): PeriodicalTitleView => {
    const kind: PeriodicalKind = r.title?.kind ?? (r.magazineCategory ? "MAGAZINE" : "NEWSPAPER");
    const publication: PeriodicalPublication = r.title?.publication ?? (kind === "MAGAZINE" ? "MONTHLY" : "DAILY");
    return {
      productId: r.productId,
      name: r.name,
      kind,
      language: r.title?.language ?? "Other",
      publisher: r.title?.publisher ?? null,
      publication,
      imageUrl: r.imageUrl,
      defaultSchedule: defaultScheduleFor(
        r.title ? { kind, publication, issueWeekday: r.title.issueWeekday, issueMonthDays: r.title.issueMonthDays } : null,
        kind,
      ),
    };
  });
  return views.sort(
    (a, b) =>
      Number(a.kind === "MAGAZINE") - Number(b.kind === "MAGAZINE") ||
      a.language.localeCompare(b.language) ||
      a.name.localeCompare(b.name),
  );
}

/* ------------------------------------------------------------ vendors */

export interface NewspaperVendorOffer {
  productId: string;
  shopProductId: string;
  name: string;
  /** Price of one copy, in paise. */
  pricePaise: number;
}

export interface NewspaperVendor {
  shopId: string;
  name: string;
  slug: string;
  shopType: string;
  /** Straight-line km from the address, when both have coordinates. */
  distanceKm: number | null;
  /** The address's society lists this vendor. */
  societyPartner: boolean;
  /** The chosen titles this vendor sells online. */
  offers: NewspaperVendorOffer[];
  /** The chosen titles this vendor does not sell. */
  missingProductIds: string[];
}

async function ownAddress(userId: string, addressId: string) {
  const [address] = await db
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId), isNull(addresses.deletedAt)))
    .limit(1);
  if (!address) throw validationFailed("Choose one of your saved delivery addresses.");
  return address;
}

/** The chosen product ids, checked: 1–20 distinct titles. */
async function assertTitles(productIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(productIds)];
  if (unique.length === 0) throw validationFailed("Choose at least one newspaper or magazine.");
  if (unique.length > 20) throw validationFailed("Choose at most 20 titles at a time.");
  const rows = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
    .leftJoin(periodicalTitles, eq(periodicalTitles.productId, products.id))
    .where(and(inArray(products.id, unique), titleConditions()));
  if (rows.length !== unique.length) throw validationFailed("One of the chosen titles is not available for subscription.");
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Vendors who deliver to the address and sell at least one chosen title
 * online — most chosen titles first, then society partners, then nearest.
 * Any shop that lists the titles counts (a paper agent, a bookstore, a
 * kirana), not only shops of the newspaper vendor type.
 */
export async function findNewspaperVendors(input: {
  userId: string;
  addressId: string;
  productIds: string[];
}): Promise<NewspaperVendor[]> {
  const address = await ownAddress(input.userId, input.addressId);
  const names = await assertTitles(input.productIds);
  const serving = await listServiceableShops(locationFromAddress(address), { limit: 500 });
  if (serving.length === 0) return [];

  const listings = await db
    .select({
      shopId: shopProducts.shopId,
      shopProductId: shopProducts.id,
      productId: shopProducts.productId,
      pricePaise: shopProducts.onlinePricePaise,
    })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(
      and(
        inArray(shopProducts.shopId, serving.map((s) => s.id)),
        inArray(shopProducts.productId, [...names.keys()]),
        isNull(shopProducts.deletedAt),
        eq(shopProducts.isActive, true),
        eq(shopProducts.isAvailable, true),
        eq(shopProducts.onlineSaleEnabled, true),
        isNotNull(shopProducts.onlinePricePaise),
        shopCarriesProductCategory(shopProducts.shopId, products.categoryId),
      ),
    );

  const byShop = new Map<string, NewspaperVendorOffer[]>();
  for (const l of listings) {
    if (l.pricePaise == null) continue;
    byShop.set(l.shopId, [
      ...(byShop.get(l.shopId) ?? []),
      { productId: l.productId, shopProductId: l.shopProductId, name: names.get(l.productId) ?? "", pricePaise: l.pricePaise },
    ]);
  }

  return serving
    .filter((shop) => byShop.has(shop.id))
    .map((shop): NewspaperVendor => {
      const offers = byShop.get(shop.id)!.sort((a, b) => a.name.localeCompare(b.name));
      const carried = new Set(offers.map((o) => o.productId));
      return {
        shopId: shop.id,
        name: shop.name,
        slug: shop.slug,
        shopType: shop.shopType,
        distanceKm: shop.distanceKm,
        societyPartner: Boolean(shop.societyPartner),
        offers,
        missingProductIds: [...names.keys()].filter((id) => !carried.has(id)),
      };
    })
    .sort(
      (a, b) =>
        b.offers.length - a.offers.length ||
        Number(b.societyPartner) - Number(a.societyPartner) ||
        (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY),
    );
}

/* ------------------------------------------------------------ submit */

export interface NewspaperSubscriptionItem {
  shopProductId: string;
  /** Copies per delivery, 1–10. */
  copies: number;
  frequency: SubscriptionFrequency;
  weekdays?: number[];
  monthDays?: number[];
}

/** Copies one delivery of one title may carry. */
export const MAX_COPIES = 10;

/**
 * Subscribes the customer to the chosen titles from one vendor. The vendor
 * must deliver to the address and every item must be a newspaper or
 * periodical listing of that vendor. All or nothing.
 */
export async function subscribeToNewspapers(input: {
  userId: string;
  shopId: string;
  addressId: string;
  startDate: IsoDate;
  endDate?: IsoDate | null;
  items: NewspaperSubscriptionItem[];
}): Promise<Subscription[]> {
  if (input.items.length === 0) throw validationFailed("Choose at least one newspaper or magazine.");
  for (const item of input.items) {
    if (!Number.isInteger(item.copies) || item.copies < 1 || item.copies > MAX_COPIES) {
      throw validationFailed(`Copies must be a whole number from 1 to ${MAX_COPIES}.`);
    }
  }
  const address = await ownAddress(input.userId, input.addressId);

  const listings = await db
    .select({
      shopProductId: shopProducts.id,
      shopId: shopProducts.shopId,
      productId: products.id,
      unitSizeMilli: products.unitSizeMilli,
    })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(and(inArray(shopProducts.id, input.items.map((i) => i.shopProductId)), isNull(shopProducts.deletedAt)));
  const listingOf = new Map(listings.map((l) => [l.shopProductId, l]));
  for (const item of input.items) {
    const listing = listingOf.get(item.shopProductId);
    if (!listing) throw notFound("Newspaper");
    if (listing.shopId !== input.shopId) throw validationFailed("Every title must come from the chosen vendor.");
  }
  await assertTitles(listings.map((l) => l.productId));

  const serving = await listServiceableShops(locationFromAddress(address), { limit: 500 });
  if (!serving.some((s) => s.id === input.shopId)) {
    throw validationFailed("This vendor does not deliver to the chosen address. Choose a vendor from the list for that address.");
  }

  return createSubscriptionGroup({
    userId: input.userId,
    shopId: input.shopId,
    addressId: input.addressId,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    items: input.items.map((item) => ({
      shopProductId: item.shopProductId,
      // One copy is one sellable unit.
      quantityMilli: item.copies * (listingOf.get(item.shopProductId)!.unitSizeMilli || MILLI_PER_UNIT),
      frequency: item.frequency,
      weekdays: item.weekdays,
      monthDays: item.monthDays,
    })),
  });
}

/* --------------------------------------------------- vendor's view */

export interface ShopSubscriber {
  subscriptionId: string;
  bundleId: string | null;
  status: Subscription["status"];
  customerName: string;
  productName: string;
  unit: string;
  isPeriodical: boolean;
  quantityMilli: number;
  frequency: Subscription["frequency"];
  weekdays: number[];
  monthDays: number[];
  startDate: IsoDate;
  endDate: IsoDate | null;
  pauseFrom: IsoDate | null;
  pauseUntil: IsoDate | null;
  nextDeliveryDate: IsoDate | null;
  address: string | null;
  createdAt: Date;
}

/** Statuses the vendor's subscriber list shows: everything still running, paused included. */
const SUBSCRIBER_STATUSES = [...DELIVERING_STATUSES, "PAUSED"] as const;

/** The shop's running subscribers, newest first (one row per subscription). */
export async function listSubscribersForShop(shopId: string, options: { limit?: number } = {}): Promise<ShopSubscriber[]> {
  const rows = await db
    .select({
      sub: subscriptions,
      customerName: users.name,
      productName: products.name,
      unit: products.unit,
      periodical: periodicalTitles.productId,
      line1: addresses.line1,
      area: addresses.area,
      city: addresses.city,
      pincode: addresses.pincode,
    })
    .from(subscriptions)
    .innerJoin(users, eq(users.id, subscriptions.userId))
    .innerJoin(shopProducts, eq(shopProducts.id, subscriptions.shopProductId))
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .leftJoin(periodicalTitles, eq(periodicalTitles.productId, products.id))
    .leftJoin(addresses, eq(addresses.id, subscriptions.addressId))
    .where(and(eq(subscriptions.shopId, shopId), inArray(subscriptions.status, [...SUBSCRIBER_STATUSES])))
    .orderBy(desc(subscriptions.createdAt), asc(products.name))
    .limit(Math.min(options.limit ?? 500, 1000));

  return rows.map((r) => ({
    subscriptionId: r.sub.id,
    bundleId: r.sub.bundleId,
    status: r.sub.status,
    customerName: r.customerName?.trim() || "Customer",
    productName: r.productName,
    unit: r.unit,
    isPeriodical: Boolean(r.periodical),
    quantityMilli: r.sub.quantityMilli,
    frequency: r.sub.frequency,
    weekdays: r.sub.weekdays,
    monthDays: r.sub.monthDays ?? [],
    startDate: r.sub.startDate,
    endDate: r.sub.endDate,
    pauseFrom: r.sub.pauseFrom,
    pauseUntil: r.sub.pauseUntil,
    nextDeliveryDate: r.sub.nextDeliveryDate,
    address: r.line1 ? [r.line1, r.area, r.city, r.pincode].filter(Boolean).join(", ") : null,
    createdAt: r.sub.createdAt,
  }));
}
