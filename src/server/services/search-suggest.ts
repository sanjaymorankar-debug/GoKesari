/**
 * Header search (docs/homepage-uiux-2026-10, F2): suggestions as the visitor
 * types, recent searches and trending searches.
 *
 * Suggestions come in three groups — products, shops, categories — matched
 * by name (ILIKE, backed by the trigram indexes of migration 0087). Products
 * sold by a shop that serves the visitor's location, and nearby shops, come
 * first. Submitting still goes to the existing /search?q= page; nothing here
 * changes what that page finds.
 */
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, max, or, sql } from "drizzle-orm";

import { CUSTOMER_CATEGORIES } from "@/lib/board/menus";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";
import { SHOP_TYPES } from "@/lib/shop-types";
import { db } from "@/server/db";
import { productCategories, products, searchQueries, shopProducts, shops } from "@/server/db/schema";
import { shopCarriesProductCategory } from "./product-categories";

export const SUGGEST_MIN_CHARS = 2;
export const SUGGEST_MAX_CHARS = 60;

export interface ProductSuggestion {
  productId: string;
  name: string;
  unit: string;
  unitSizeMilli: number;
  /** Shops selling it (all), and how many of them serve the visitor's location. */
  shopCount: number;
  nearbyCount: number;
  href: string;
}
export interface ShopSuggestion {
  slug: string;
  name: string;
  area: string | null;
  city: string;
  distanceKm: number | null;
  href: string;
}
export interface CategorySuggestion {
  key: string;
  label: string;
  href: string;
}
export interface Suggestions {
  query: string;
  products: ProductSuggestion[];
  shops: ShopSuggestion[];
  categories: CategorySuggestion[];
}

/** Lower-case, single-spaced, trimmed and cut to the column limit — the form searches are stored and compared in. */
export function normaliseQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80);
}

/** Escapes LIKE wildcards so "50%" or "a_b" match literally. */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Category suggestions from fixed lists (no database): the home page's
 * category tiles in every language, then the 44 shop types by name.
 */
export function matchCategories(query: string, lang: Lang, limit = 4): CategorySuggestion[] {
  const q = query.trim().toLowerCase();
  if (q.length < SUGGEST_MIN_CHARS) return [];
  const out: CategorySuggestion[] = [];
  const seen = new Set<string>();
  const push = (key: string, label: string, href: string) => {
    if (seen.has(href) || out.length >= limit) return;
    seen.add(href);
    out.push({ key, label, href });
  };
  for (const c of CUSTOMER_CATEGORIES) {
    if (c.key === "all") continue;
    if (Object.values(c.label).some((l) => l.toLowerCase().includes(q))) push(c.key, tr(c.label, lang), c.href);
  }
  for (const t of SHOP_TYPES) {
    if (t.label.toLowerCase().includes(q)) push(t.key, t.label, `/shops?type=${t.key}`);
  }
  return out;
}

/**
 * Suggestions for what the visitor has typed so far. `nearby` is the shops
 * serving their location (id → km), when they have one.
 */
export async function suggest(rawQuery: string, options: { lang: Lang; nearby?: ReadonlyMap<string, number | null> }): Promise<Suggestions> {
  const query = rawQuery.replace(/\s+/g, " ").trim().slice(0, SUGGEST_MAX_CHARS);
  const empty: Suggestions = { query, products: [], shops: [], categories: [] };
  if (query.length < SUGGEST_MIN_CHARS) return empty;
  const pattern = likePattern(query);
  const lower = query.toLowerCase();
  const nearbyIds = options.nearby ? [...options.nearby.keys()] : [];
  const nearbyCount = nearbyIds.length
    ? sql<number>`count(distinct ${shopProducts.shopId}) filter (where ${inArray(shopProducts.shopId, nearbyIds)})::int`
    : sql<number>`0::int`;

  const [productRows, shopRows, categoryRows] = await Promise.all([
    db
      .select({
        productId: products.id,
        name: products.name,
        unit: products.unit,
        unitSizeMilli: products.unitSizeMilli,
        shopCount: sql<number>`count(distinct ${shopProducts.shopId})::int`,
        nearbyCount,
      })
      .from(shopProducts)
      .innerJoin(products, eq(products.id, shopProducts.productId))
      .innerJoin(shops, eq(shops.id, shopProducts.shopId))
      .where(
        and(
          ilike(products.name, pattern),
          eq(shops.status, "APPROVED"),
          isNull(shops.deletedAt),
          eq(shopProducts.isActive, true),
          isNull(shopProducts.deletedAt),
          eq(products.isActive, true),
          shopCarriesProductCategory(shopProducts.shopId, products.categoryId),
        ),
      )
      .groupBy(products.id, products.name, products.unit, products.unitSizeMilli)
      .orderBy(
        ...(nearbyIds.length ? [desc(nearbyCount)] : []),
        // Names that start with what was typed, then where it appears, then shorter names.
        asc(sql`position(${lower} in lower(${products.name}))`),
        asc(sql`length(${products.name})`),
        asc(products.name),
      )
      .limit(6),
    db
      .select({ id: shops.id, slug: shops.slug, name: shops.name, area: shops.area, city: shops.city })
      .from(shops)
      .where(and(eq(shops.status, "APPROVED"), isNull(shops.deletedAt), or(ilike(shops.name, pattern), ilike(shops.area, pattern))))
      .orderBy(asc(sql`position(${lower} in lower(${shops.name}))`), asc(shops.name))
      .limit(20),
    db
      .select({ name: productCategories.name })
      .from(productCategories)
      .where(and(eq(productCategories.isActive, true), isNull(productCategories.deletedAt), ilike(productCategories.name, pattern)))
      .orderBy(asc(productCategories.sortOrder), asc(productCategories.name))
      .limit(4),
  ]);

  const km = (id: string) => options.nearby?.get(id) ?? null;
  const isNear = (id: string) => options.nearby?.has(id) ?? false;
  const shopList = shopRows
    // Nearby shops first, nearest first; then the rest in match order.
    .map((s, i) => ({ s, i }))
    .sort((a, b) => Number(isNear(b.s.id)) - Number(isNear(a.s.id)) || (km(a.s.id) ?? 1e9) - (km(b.s.id) ?? 1e9) || a.i - b.i)
    .slice(0, 4)
    .map(({ s }) => ({ slug: s.slug, name: s.name, area: s.area, city: s.city, distanceKm: km(s.id), href: `/shops/${s.slug}` }));

  const categories = matchCategories(query, options.lang, 4);
  for (const c of categoryRows) {
    if (categories.length >= 4) break;
    const href = `/search?q=${encodeURIComponent(c.name)}`;
    if (!categories.some((x) => x.href === href)) categories.push({ key: `cat-${c.name}`, label: c.name, href });
  }

  return {
    query,
    products: productRows.map((p) => ({
      ...p,
      shopCount: Number(p.shopCount),
      nearbyCount: Number(p.nearbyCount),
      href: `/search?q=${encodeURIComponent(p.name)}`,
    })),
    shops: shopList,
    categories,
  };
}

/* ------------------------------------------------------ recent & trending */

/** Shown as "Trending" until enough people have searched. Searched in English (how products are named). */
export const DEFAULT_TRENDING: readonly { q: string; label: Text }[] = [
  { q: "milk", label: L("Milk", "दूध", "दूध") },
  { q: "bread", label: L("Bread", "ब्रेड", "ब्रेड") },
  { q: "paneer", label: L("Paneer", "पनीर", "पनीर") },
  { q: "curd", label: L("Curd", "दही", "दही") },
  { q: "eggs", label: L("Eggs", "अंडे", "अंडी") },
  { q: "atta", label: L("Atta", "आटा", "पीठ") },
];

/** Keeps one search. Never throws: a search must work even when this cannot be written. */
export async function recordSearch(userId: string | null, rawQuery: string): Promise<void> {
  const query = normaliseQuery(rawQuery);
  if (query.length < SUGGEST_MIN_CHARS) return;
  try {
    await db.insert(searchQueries).values({ userId, query });
  } catch (error) {
    console.error("[search] could not record a search", error);
  }
}

/** A customer's own latest distinct searches, newest first. */
export async function listRecentSearches(userId: string, limit = 6): Promise<string[]> {
  try {
    const rows = await db
      .select({ query: searchQueries.query, last: max(searchQueries.createdAt) })
      .from(searchQueries)
      .where(eq(searchQueries.userId, userId))
      .groupBy(searchQueries.query)
      .orderBy(desc(max(searchQueries.createdAt)))
      .limit(limit);
    return rows.map((r) => r.query);
  } catch (error) {
    console.error("[search] recent searches could not be read", error);
    return [];
  }
}

export async function clearRecentSearches(userId: string): Promise<void> {
  await db.delete(searchQueries).where(eq(searchQueries.userId, userId));
}

/**
 * What people searched most in the last week (at least two searches each),
 * topped up with the defaults. Labels are the searches as typed, except the
 * defaults, which are in the visitor's language.
 */
export async function listTrendingSearches(lang: Lang, limit = 6): Promise<{ q: string; label: string }[]> {
  const since = new Date(Date.now() - 7 * 86_400_000);
  let rows: { query: string }[] = [];
  try {
    rows = await db
      .select({ query: searchQueries.query })
      .from(searchQueries)
      .where(and(gte(searchQueries.createdAt, since), isNotNull(searchQueries.query)))
      .groupBy(searchQueries.query)
      .having(sql`${count()} >= 2`)
      .orderBy(desc(count()), asc(searchQueries.query))
      .limit(limit);
  } catch (error) {
    console.error("[search] trending searches could not be read", error);
  }
  const out = rows.map((r) => ({ q: r.query, label: r.query }));
  for (const d of DEFAULT_TRENDING) {
    if (out.length >= limit) break;
    if (!out.some((o) => o.q === d.q)) out.push({ q: d.q, label: tr(d.label, lang) });
  }
  return out;
}
