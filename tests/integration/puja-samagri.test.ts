/**
 * Puja Samagri & Temple Supplies (docs/puja-samagri-2026-11) against real PostgreSQL:
 * the brief's §9 test scope that runs without a browser.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { db } from "@/server/db";
import {
  festivalCollections,
  homeBanners,
  inventoryMovements,
  listingPriceRequests,
  notifications,
  orders,
  productCatalogueAttrs,
  productCategories,
  productMrpHistory,
  products,
  productSubcategories,
  shopAddedTypes,
  shopProducts,
  wallets,
} from "@/server/db/schema";
import {
  decideSubmission,
  exportMasterCatalogueCsv,
  getPujaConfig,
  importMasterCatalogueCsv,
  liveFestivalCollections,
  listSubmissions,
  mergeMasterProducts,
  saveFestivalCollection,
  setPujaConfig,
  updateMasterProduct,
} from "@/server/puja/admin";
import { pujaCatalogue } from "@/server/puja/catalogue";
import { runPujaSeed, type SqlExec } from "@/server/puja/seed-runner";
import {
  browsePujaCatalogue,
  createOwnProducts,
  getPujaSetup,
  createProductType,
  listPujaTypes,
  listRemovedListings,
  restoreListings,
  seedPujaCatalogue,
} from "@/server/puja/service";
import { answerPriceRequest, listPujaStorefront, requestListingPrice } from "@/server/puja/storefront";
import { addToCart } from "@/server/services/cart";
import { listStorefrontProducts, removeShopProduct } from "@/server/services/catalogue";
import { findNearbyShops } from "@/server/services/nearby-shops";
import { cancelOrder, checkout } from "@/server/services/orders";
import { setShopMrp } from "@/server/services/shop-product-setup";
import { createShop, createUser, createUserWithWallet, deliveryAddressId, resetDatabase } from "../helpers/fixtures";

const exec: SqlExec = async (text) => (await db.execute(sql.raw(text))) as unknown as Record<string, unknown>[];
const TOTAL = pujaCatalogue().length;

async function pujaShop(name = "Shree Puja Bhandar", shopType = "PUJA_SAMAGRI") {
  const owner = await createUser({ role: "SHOP_OWNER", name: `${name} owner` });
  const shop = await createShop(owner.id, { shopType, name, latitude: 18.52, longitude: 73.85 });
  return { owner, shop, actor: { id: owner.id, role: "SHOP_OWNER" as const } };
}

async function categoryId(slug: string): Promise<string> {
  const [c] = await db.select({ id: productCategories.id }).from(productCategories).where(eq(productCategories.slug, slug));
  return c.id;
}

async function productBySlug(slug: string) {
  const [p] = await db.select().from(products).where(eq(products.slug, slug));
  return p;
}

async function listingOf(shopId: string, productId: string) {
  const [l] = await db.select().from(shopProducts).where(and(eq(shopProducts.shopId, shopId), eq(shopProducts.productId, productId)));
  return l;
}

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  // resetDatabase empties the catalogue tables: seed the puja catalogue again (the migration's SQL).
  await runPujaSeed(exec);
  await db.execute(sql`DELETE FROM platform_settings WHERE key = 'pujaSamagri'`);
  await db.execute(sql`UPDATE shop_types SET status = 'ACTIVE' WHERE key = 'PUJA_SAMAGRI'`);
});

describe("seed", () => {
  it("loads the full catalogue with Hindi / Marathi names, and a re-run adds nothing", async () => {
    const first = await runPujaSeed(exec);
    expect(first).toMatchObject({ shopType: 1, categories: 15, types: 80, products: TOTAL, localNames: TOTAL, missingLocalNames: 0, loosePriced: 0, duplicateNames: 0 });
    const again = await runPujaSeed(exec);
    expect(again).toEqual(first);
  });
});

describe("taking the catalogue (rule 3, §5a)", () => {
  it("adds every product at stock 100, priced at MRP, loose ones with an empty price; unticked ones are left out", async () => {
    const { shop, actor } = await pujaShop();
    const flowers = await categoryId("puja-phool-patte");
    const rose = await productBySlug("puja-rose-agarbatti-box-20-sticks");
    const result = await seedPujaCatalogue(shop.id, { excludeCategoryIds: [flowers], excludeProductIds: [rose.id] }, actor);
    const flowerCount = pujaCatalogue().filter((r) => r.categorySlug === "puja-phool-patte").length;
    expect(result.added).toBe(TOTAL - flowerCount - 1);
    expect(result.stock).toBe(100);
    expect(result.firstProducts).toBe(true);

    const kapur = await listingOf(shop.id, (await productBySlug("puja-bhimseni-kapur-10-g")).id);
    expect(Number(kapur.onlineStock)).toBe(100);
    expect(kapur.onlinePricePaise).toBe(6000);
    expect(kapur.onlineSaleEnabled).toBe(true);
    const loose = await listingOf(shop.id, (await productBySlug("puja-kapur-loose-loose-per-kg")).id);
    expect(loose.onlinePricePaise).toBeNull();
    expect(loose.onlineSaleEnabled).toBe(false);
    expect(Number(loose.onlineStock)).toBe(100);
    expect(await listingOf(shop.id, rose.id)).toBeUndefined();
    const [moves] = await db.select({ n: sql<number>`count(*)::int` }).from(inventoryMovements).where(eq(inventoryMovements.source, "puja_catalogue"));
    expect(moves.n).toBe(result.added);

    const setup = await getPujaSetup(shop.id);
    expect(setup.categories.reduce((n, c) => n + c.productCount, 0)).toBe(TOTAL);
    expect(setup.categories.find((c) => c.slug === "puja-phool-patte")?.listed).toBe(0);

    const again = await seedPujaCatalogue(shop.id, {}, actor);
    expect(again.added).toBe(flowerCount + 1);
    expect(again.alreadyListed).toBe(TOTAL - flowerCount - 1);
    expect(again.firstProducts).toBe(false);
  });

  it("records Puja Samagri as an added type for a shop of another type", async () => {
    const { shop, actor } = await pujaShop("Gupta Kirana", "GROCERY_KIRANA");
    const r = await seedPujaCatalogue(shop.id, { onlyProductIds: [(await productBySlug("puja-bhimseni-kapur-10-g")).id] }, actor);
    expect(r).toMatchObject({ added: 1, addedType: true });
    const added = await db.select().from(shopAddedTypes).where(eq(shopAddedTypes.shopId, shop.id));
    expect(added.map((a) => a.shopTypeKey)).toEqual(["PUJA_SAMAGRI"]);
  });

  it("is refused while the shop type is switched off", async () => {
    const { shop, actor } = await pujaShop();
    await db.execute(sql`UPDATE shop_types SET status = 'INACTIVE' WHERE key = 'PUJA_SAMAGRI'`);
    await expect(seedPujaCatalogue(shop.id, {}, actor)).rejects.toThrow(/switched off/);
  });
});

describe("shop-only MRP, remove and restore (§5c, §5d)", () => {
  it("a shop's MRP applies to that shop only — never the master or other shops", async () => {
    const a = await pujaShop("Shop A");
    const b = await pujaShop("Shop B");
    const p = await productBySlug("puja-kapur-tablets-100-g");
    await seedPujaCatalogue(a.shop.id, { onlyProductIds: [p.id] }, a.actor);
    await seedPujaCatalogue(b.shop.id, { onlyProductIds: [p.id] }, b.actor);
    const la = await listingOf(a.shop.id, p.id);
    await setShopMrp(la.id, a.shop.id, 15_900, a.actor, db);
    expect((await productBySlug("puja-kapur-tablets-100-g")).mrpPaise).toBe(14_500);
    const offers = await listStorefrontProducts({ productId: p.id });
    expect(offers.find((o) => o.shopId === a.shop.id)?.mrpPaise).toBe(15_900);
    expect(offers.find((o) => o.shopId === b.shop.id)?.mrpPaise).toBe(14_500);
  });

  it("restores a removed product with its price and stock", async () => {
    const { shop, actor } = await pujaShop();
    const p = await productBySlug("puja-kapur-tablets-100-g");
    await seedPujaCatalogue(shop.id, { onlyProductIds: [p.id] }, actor);
    const l = await listingOf(shop.id, p.id);
    await removeShopProduct(l.id, actor);
    const removed = await listRemovedListings(shop.id);
    expect(removed.map((r) => r.id)).toEqual([l.id]);
    await restoreListings(shop.id, [l.id], actor);
    const back = await listingOf(shop.id, p.id);
    expect(back.deletedAt).toBeNull();
    expect(back.onlineSaleEnabled).toBe(true);
    expect(back.onlinePricePaise).toBe(14_500);
    expect(Number(back.onlineStock)).toBe(100);
  });
});

describe("own product types and products, duplicate check, review (§5f–h, §6)", () => {
  it("stops an exact or close type name, creates it on confirm, and keeps it private until approved", async () => {
    const { shop, owner, actor } = await pujaShop();
    const other = await pujaShop("Other Puja");
    const cat = await categoryId("puja-agarbatti-dhoop");
    await expect(createProductType(shop.id, { categoryId: cat, name: "Agarbatti", unit: "pack" }, actor)).rejects.toMatchObject({ status: 409 });
    const close = await createProductType(shop.id, { categoryId: cat, name: "Agarbati", unit: "pack" }, actor).catch((e) => e);
    expect(close.status).toBe(409);
    expect(close.details.matches[0].name).toBe("Agarbatti");
    const made = await createProductType(shop.id, { categoryId: cat, name: "Agarbati", nameHi: "अगरबत्ती विशेष", unit: "pack", confirmDuplicate: true }, actor);
    expect(made.type.approvalStatus).toBe("PENDING_APPROVAL");
    expect((await listPujaTypes(shop.id)).some((t) => t.id === made.type.id && t.ownedByShop)).toBe(true);
    expect((await listPujaTypes(other.shop.id)).some((t) => t.id === made.type.id)).toBe(false);

    // A distinct new type, approved: every shop sees it, the owner is notified.
    const fresh = await createProductType(shop.id, { categoryId: cat, name: "Hawan Cup Cones", unit: "box" }, actor);
    const admin = await createUser({ role: "ADMIN" });
    expect((await listSubmissions()).filter((s) => s.kind === "TYPE").length).toBe(2);
    await decideSubmission({ kind: "TYPE", id: fresh.type.id, decision: "APPROVE" }, { id: admin.id, role: "ADMIN" });
    expect((await listPujaTypes(other.shop.id)).some((t) => t.id === fresh.type.id)).toBe(true);
    await expect(decideSubmission({ kind: "TYPE", id: made.type.id, decision: "REJECT" }, { id: admin.id, role: "ADMIN" })).rejects.toThrow(/reason/);
    const agarbatti = (await listPujaTypes()).find((t) => t.name === "Agarbatti")!;
    await decideSubmission({ kind: "TYPE", id: made.type.id, decision: "MERGE", reason: "Same as Agarbatti", mergeIntoId: agarbatti.id }, { id: admin.id, role: "ADMIN" });
    const [merged] = await db.select().from(productSubcategories).where(eq(productSubcategories.id, made.type.id));
    expect(merged).toMatchObject({ approvalStatus: "MERGED", mergedIntoId: agarbatti.id, ownerShopId: shop.id });
    const notes = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.catalogue_submission_decided")));
    expect(notes.length).toBe(2);
  });

  it("creates an owner's product with variants, visible in that shop at once, and the review approves or rejects it", async () => {
    const { shop, owner, actor } = await pujaShop();
    const other = await pujaShop("Other Puja");
    const cat = await categoryId("puja-agarbatti-dhoop");
    const close = await createOwnProducts(shop.id, { categoryId: cat, name: "Rose Agarbati", unit: "pack", variants: [{ label: "Box, 20 sticks", pricePaise: 2000, stock: 10 }] }, actor).catch((e) => e);
    expect(close.status).toBe(409);
    expect(close.details.matches.length).toBeGreaterThan(0);

    const made = await createOwnProducts(
      shop.id,
      {
        categoryId: cat,
        name: "Kasturi Agarbatti",
        nameHi: "कस्तूरी अगरबत्ती",
        nameMr: "कस्तुरी अगरबत्ती",
        synonyms: ["kasturi", "musk"],
        unit: "pack",
        variants: [
          { label: "50 g", mrpPaise: 5000, pricePaise: 4500, stock: 20 },
          { label: "100 g", mrpPaise: 9000, pricePaise: 8500, stock: 5 },
        ],
      },
      actor,
    );
    expect(made.created).toHaveLength(2);
    const mine = await browsePujaCatalogue({ shopId: shop.id, q: "कस्तूरी" });
    expect(mine.items.map((i) => i.name).sort()).toEqual(["Kasturi Agarbatti – 100 g", "Kasturi Agarbatti – 50 g"]);
    expect((await browsePujaCatalogue({ shopId: other.shop.id, q: "kasturi" })).items).toHaveLength(0);
    const buyable = await listPujaStorefront({ shopId: shop.id, q: "musk" });
    expect(buyable.items).toHaveLength(2);

    const admin = { id: (await createUser({ role: "OPERATOR" })).id, role: "OPERATOR" as const };
    await decideSubmission({ kind: "PRODUCT", id: made.created[0].productId, decision: "APPROVE" }, admin);
    await decideSubmission({ kind: "PRODUCT", id: made.created[1].productId, decision: "REJECT", reason: "Please use the 100 g pack from the master" }, admin);
    expect((await browsePujaCatalogue({ shopId: other.shop.id, q: "kasturi" })).items.map((i) => i.name)).toEqual(["Kasturi Agarbatti – 50 g"]);
    // The creating shop's own data stays unchanged.
    expect(await listingOf(shop.id, made.created[1].productId)).toMatchObject({ onlinePricePaise: 8500, deletedAt: null });
    const notes = await db.select().from(notifications).where(eq(notifications.userId, owner.id));
    expect(notes.some((n) => /not added to the master/.test(n.body))).toBe(true);
  });
});

describe("customer search, filters, price on confirmation (§7)", () => {
  it("finds products by English, Hindi, Marathi names and synonyms, on the puja page and in site search", async () => {
    const { shop, actor } = await pujaShop();
    await seedPujaCatalogue(shop.id, {}, actor);
    // every: each hit is that product; some: the word is also a category's name ("Mombatti, Diye & Batti").
    for (const [q, expected, all] of [
      ["कपूर", /Kapur/, true],
      ["camphor", /Kapur/, true],
      ["मेणबत्ती", /Candle/, true],
      ["mombatti", /Candle/, false],
      ["agarbathi", /Agarbatti/, false],
      ["कुंकू", /Kumkum/, true],
    ] as const) {
      const r = await listPujaStorefront({ q, limit: 100 });
      const hit = (i: (typeof r.items)[number]) => expected.test(i.productName) || expected.test(i.typeName ?? "");
      expect(r.items.length, q).toBeGreaterThan(0);
      if (all) expect(r.items.every(hit), q).toBe(true);
      else expect(r.items.some(hit), q).toBe(true);
    }
    const site = await listStorefrontProducts({ query: "कापूर", limit: 50 });
    expect(site.length).toBeGreaterThan(0);
    expect(site.every((s) => /Kapur/.test(s.productName))).toBe(true);
  });

  it("filters by category, festival, loose / packed, price and stock", async () => {
    const { shop, actor } = await pujaShop();
    await seedPujaCatalogue(shop.id, {}, actor);
    const kits = await listPujaStorefront({ categoryId: await categoryId("puja-ready-kits"), limit: 100 });
    expect(kits.items.length).toBe(pujaCatalogue().filter((r) => r.categorySlug === "puja-ready-kits").length);
    const diwali = await listPujaStorefront({ festival: "diwali", limit: 100 });
    expect(diwali.items.every((i) => i.festivals.includes("diwali"))).toBe(true);
    const loose = await listPujaStorefront({ kind: "loose", limit: 100 });
    expect(loose.items.length).toBeGreaterThan(0);
    expect(loose.items.every((i) => i.kind === "LOOSE" && i.priceOnConfirmation)).toBe(true);
    const cheap = await listPujaStorefront({ maxPricePaise: 3000, limit: 100 });
    expect(cheap.items.every((i) => (i.onlinePricePaise ?? 0) <= 3000)).toBe(true);
    const p = await productBySlug("puja-bhimseni-kapur-10-g");
    await db.update(shopProducts).set({ onlineStock: 0 }).where(eq(shopProducts.productId, p.id));
    expect((await listPujaStorefront({ q: "bhimseni", inStock: true, limit: 50 })).items.some((i) => i.productId === p.id)).toBe(false);
  });

  it("shows loose items as price on confirmation; the shop's answer prices the listing and tells the customer", async () => {
    const { shop, owner, actor } = await pujaShop();
    const p = await productBySlug("puja-marigold-flowers-loose-loose-per-kg");
    await seedPujaCatalogue(shop.id, { onlyProductIds: [p.id] }, actor);
    const [item] = (await listPujaStorefront({ shopId: shop.id })).items;
    expect(item.priceOnConfirmation).toBe(true);
    const customer = await createUser();
    const asked = await requestListingPrice(customer.id, item.shopProductId, { quantity: 2 });
    expect(asked.alreadyAsked).toBe(false);
    expect((await requestListingPrice(customer.id, item.shopProductId, {})).alreadyAsked).toBe(true);
    const ownerNote = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.price_requested")));
    expect(ownerNote).toHaveLength(1);
    const answer = await answerPriceRequest(shop.id, asked.request.id, { pricePaise: 12_000 }, actor);
    expect(answer).toMatchObject({ status: "ANSWERED", customers: 1 });
    const l = await listingOf(shop.id, p.id);
    expect(l).toMatchObject({ onlinePricePaise: 12_000, onlineSaleEnabled: true });
    const [req] = await db.select().from(listingPriceRequests).where(eq(listingPriceRequests.id, asked.request.id));
    expect(req.status).toBe("ANSWERED");
    const customerNote = await db.select().from(notifications).where(and(eq(notifications.userId, customer.id), eq(notifications.type, "order.price_confirmed")));
    expect(customerNote).toHaveLength(1);
    expect((await listStorefrontProducts({ productId: p.id })).length).toBe(1);
  });

  it("orders puja items through the existing cart, checkout and cancellation (refund before packing)", async () => {
    const { shop, actor } = await pujaShop();
    const p = await productBySlug("puja-kapur-tablets-100-g");
    await seedPujaCatalogue(shop.id, { onlyProductIds: [p.id] }, actor);
    const { user: customer } = await createUserWithWallet({ balancePaise: 100_000 });
    const l = await listingOf(shop.id, p.id);
    await addToCart(customer.id, l.id, 2);
    const { orders: placed } = await checkout({ userId: customer.id, addressId: await deliveryAddressId(customer.id), requestId: "puja-req-1" });
    expect(placed).toHaveLength(1);
    expect(placed[0].status).toBe("CONFIRMED");
    expect(Number((await listingOf(shop.id, p.id)).onlineStock)).toBe(98);
    await cancelOrder(placed[0].id, { id: customer.id, role: "CUSTOMER" }, "Changed my mind");
    const [o] = await db.select().from(orders).where(eq(orders.id, placed[0].id));
    expect(["CANCELLED", "REFUNDED"]).toContain(o.status);
    const [w] = await db.select().from(wallets).where(eq(wallets.userId, customer.id));
    expect(w.balancePaise).toBe(100_000);
  });
});

describe("FSSAI toggle for edible lines (§6)", () => {
  it("needs FSSAI only when the shop lists edible items and the toggle is on", async () => {
    const { shop, actor } = await pujaShop();
    const sellsFood = async () => {
      const [r] = (await db.execute(sql`SELECT shop_sells_food(${shop.id}::uuid, 'PUJA_SAMAGRI') AS food`)) as unknown as { food: boolean }[];
      return r.food;
    };
    await seedPujaCatalogue(shop.id, { excludeCategoryIds: [await categoryId("puja-prasad-dry-items"), await categoryId("puja-ready-kits"), await categoryId("puja-temple-bulk"), await categoryId("puja-festival-items"), await categoryId("puja-mombatti-diye-batti"), await categoryId("puja-havan-samagri")] }, actor);
    expect(await sellsFood()).toBe(false);
    await seedPujaCatalogue(shop.id, { onlyProductIds: [(await productBySlug("puja-laung-cloves-10-g")).id] }, actor);
    expect(await sellsFood()).toBe(true);
    const admin = await createUser({ role: "ADMIN" });
    await setPujaConfig({ edibleNeedsFssai: false }, { id: admin.id, role: "ADMIN" });
    expect(await sellsFood()).toBe(false);
    // Other shop types are unchanged.
    const dairy = await createShop(admin.id, { shopType: "DAIRY" });
    const [d] = (await db.execute(sql`SELECT shop_sells_food(${dairy.id}::uuid, 'DAIRY') AS food`)) as unknown as { food: boolean }[];
    expect(d.food).toBe(true);
  });
});

describe("admin catalogue, festivals, configuration (§6)", () => {
  it("edits a master product (MRP history, HSN/GST verified, names), retires and merges duplicates", async () => {
    const admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" as const };
    const p = await productBySlug("puja-bhimseni-kapur-10-g");
    await updateMasterProduct(p.id, { mrpPaise: 6500, taxToVerify: false, nameMr: "भीमसेनी कापूर (१० ग्रॅम)", synonyms: ["bhimseni", "edible camphor"] }, admin);
    expect((await productBySlug("puja-bhimseni-kapur-10-g")).mrpPaise).toBe(6500);
    expect((await db.select().from(productMrpHistory).where(eq(productMrpHistory.productId, p.id))).length).toBe(1);
    const [attrs] = await db.select().from(productCatalogueAttrs).where(eq(productCatalogueAttrs.productId, p.id));
    expect(attrs.taxToVerify).toBe(false);
    expect((await browsePujaCatalogue({ q: "१० ग्रॅम" })).items.map((i) => i.productId)).toEqual([p.id]);

    const { shop, actor } = await pujaShop();
    const dup = await productBySlug("puja-kapur-cubes-25-g");
    await seedPujaCatalogue(shop.id, { onlyProductIds: [dup.id] }, actor);
    const merged = await mergeMasterProducts(dup.id, (await productBySlug("puja-kapur-cubes-100-g")).id, admin, "test merge");
    expect(merged.shopListingsKept).toBe(1);
    expect((await productBySlug("puja-kapur-cubes-25-g")).isActive).toBe(false);
    expect((await browsePujaCatalogue({ q: "kapur cubes" })).items.some((i) => i.productId === dup.id)).toBe(false);
    expect((await listingOf(shop.id, dup.id)).deletedAt).toBeNull();
  });

  it("exports the catalogue as CSV and imports edits, reporting bad rows", async () => {
    const admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" as const };
    const csv = await exportMasterCatalogueCsv();
    const lines = csv.trim().split("\n");
    expect(lines.length).toBe(TOTAL + 1);
    expect(lines[0]).toContain("HSN/GST status");
    const p = await productBySlug("puja-roli-25-g");
    const header = lines[0];
    const row = lines.find((l) => l.startsWith(p.code + ","))!;
    const edited = row.replace(",To verify with CA,", ",Verified,");
    const bad = row.replace(p.code, "P99999");
    const report = await importMasterCatalogueCsv([header, edited, bad].join("\n"), admin);
    expect(report.updated).toBe(1);
    expect(report.errors).toEqual([{ row: 3, message: "No product with code P99999." }]);
    const [attrs] = await db.select().from(productCatalogueAttrs).where(eq(productCatalogueAttrs.productId, p.id));
    expect(attrs.taxToVerify).toBe(false);
  });

  it("schedules a festival collection with a home banner, and lists kits first while it runs", async () => {
    const admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" as const };
    const now = Date.now();
    const saved = await saveFestivalCollection(
      null,
      { festivalKey: "diwali", title: "Diwali puja kits", startsAt: new Date(now - 3600_000), endsAt: new Date(now + 86_400_000), showOnHome: true },
      admin,
    );
    expect(saved.homeBannerId).not.toBeNull();
    const [banner] = await db.select().from(homeBanners).where(eq(homeBanners.id, saved.homeBannerId!));
    expect(banner.ctaHref).toBe("/puja?festival=diwali");
    const live = await liveFestivalCollections();
    expect(live.map((l) => l.id)).toEqual([saved.id]);
    expect((await db.select().from(festivalCollections)).length).toBe(1);

    const { shop, actor } = await pujaShop();
    await seedPujaCatalogue(shop.id, {}, actor);
    const first = await listPujaStorefront({ liveFestivals: ["diwali"], limit: 30 });
    expect(first.items[0].categoryName).toBe("Ready Puja Kits");
  });

  it("switches the shop type off and on, and reports the counts", async () => {
    const admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" as const };
    expect((await setPujaConfig({ enabled: false }, admin)).enabled).toBe(false);
    const config = await setPujaConfig({ enabled: true, seedDefaultStock: 50 }, admin);
    expect(config).toMatchObject({ enabled: true, seedDefaultStock: 50, edibleNeedsFssai: true });
    expect((await getPujaConfig()).counts).toMatchObject({ products: TOTAL, categories: 15, types: 80, taxToVerify: TOTAL });
  });
});

describe("nearby (§7)", () => {
  it("keeps puja shops (primary or added type) when type=PUJA_SAMAGRI", async () => {
    const puja = await pujaShop("Puja One");
    const kirana = await pujaShop("Kirana With Puja", "GROCERY_KIRANA");
    const dairyOnly = await pujaShop("Dairy Only", "DAIRY");
    await seedPujaCatalogue(kirana.shop.id, { onlyProductIds: [(await productBySlug("puja-bhimseni-kapur-10-g")).id] }, kirana.actor);
    const all = await findNearbyShops({ latitude: 18.52, longitude: 73.85 }, 5);
    expect(all.shops.length).toBe(3);
    const only = await findNearbyShops({ latitude: 18.52, longitude: 73.85 }, 5, { shopType: "PUJA_SAMAGRI" });
    expect(only.shops.map((s) => s.id).sort()).toEqual([puja.shop.id, kirana.shop.id].sort());
    expect(only.shops.some((s) => s.id === dairyOnly.shop.id)).toBe(false);
  });
});
