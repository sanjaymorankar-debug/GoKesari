/**
 * Seeds reference data and a demonstration marketplace.
 *
 * Idempotent: re-running updates rather than duplicating, so it is safe to run
 * against an existing database. Catalogue data (§7) is seeded into the database
 * rather than hard-coded into the UI, so operators can extend it at runtime.
 *
 *   npm run db:seed              reference data + demo shops
 *   npm run db:seed -- --minimal reference data only (use for production)
 */
import "dotenv/config";

import { eq, sql } from "drizzle-orm";

import { db } from "./index";
import {
  permissions as permissionsTable,
  productCategories,
  products,
  rolePermissions,
  roles,
  shopProducts,
  shops,
  users,
  wallets,
} from "./schema";
import {
  PERMISSION_DESCRIPTIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
} from "../authz/permissions";
import { SHOP_TYPES } from "@/lib/shop-types";
import { ensureGeneralCategory } from "@/server/services/product-categories";

/** Requirement §7 — the starting catalogue. */
const DAIRY_CATALOGUE = [
  { category: "Milk", unit: "L", subscribable: true, items: ["Cow Milk", "Buffalo Milk", "Toned Milk", "Full Cream Milk"] },
  { category: "Curd", unit: "kg", subscribable: true, items: ["Fresh Curd", "Greek Curd"] },
  { category: "Buttermilk", unit: "L", subscribable: true, items: ["Masala Buttermilk", "Plain Buttermilk"] },
  { category: "Paneer", unit: "kg", subscribable: false, items: ["Fresh Paneer", "Malai Paneer"] },
  { category: "Cheese", unit: "kg", subscribable: false, items: ["Processed Cheese", "Mozzarella"] },
  { category: "Butter", unit: "kg", subscribable: false, items: ["Salted Butter", "White Butter"] },
  { category: "Ghee", unit: "L", subscribable: false, items: ["Cow Ghee", "Buffalo Ghee"] },
  { category: "Flavoured Milk", unit: "ml", subscribable: true, items: ["Rose Milk", "Badam Milk", "Chocolate Milk"] },
  { category: "Lassi", unit: "ml", subscribable: true, items: ["Sweet Lassi", "Mango Lassi"] },
] as const;

const BAKERY_CATALOGUE = [
  { category: "Bread", unit: "piece", subscribable: true, items: ["White Bread", "Brown Bread", "Multigrain Bread"] },
  { category: "Buns", unit: "piece", subscribable: true, items: ["Pav", "Burger Bun"] },
  { category: "Cakes", unit: "piece", subscribable: false, items: ["Vanilla Sponge", "Chocolate Truffle"] },
  { category: "Pastries", unit: "piece", subscribable: false, items: ["Chocolate Pastry", "Pineapple Pastry"] },
  { category: "Cookies", unit: "g", subscribable: false, items: ["Butter Cookies", "Choco Chip Cookies"] },
  { category: "Biscuits", unit: "g", subscribable: false, items: ["Nankhatai", "Salted Biscuits"] },
  { category: "Khari", unit: "g", subscribable: false, items: ["Butter Khari", "Masala Khari"] },
  { category: "Puffs", unit: "piece", subscribable: false, items: ["Veg Puff", "Paneer Puff"] },
  { category: "Donuts", unit: "piece", subscribable: false, items: ["Glazed Donut", "Choco Donut"] },
] as const;

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function seedRolesAndPermissions(): Promise<void> {
  for (const [key, label] of Object.entries(ROLE_LABELS)) {
    await db
      .insert(roles)
      .values({ key: key as keyof typeof ROLE_LABELS, label })
      .onConflictDoUpdate({ target: roles.key, set: { label } });
  }

  for (const [key, description] of Object.entries(PERMISSION_DESCRIPTIONS)) {
    await db
      .insert(permissionsTable)
      .values({ key, description })
      .onConflictDoUpdate({ target: permissionsTable.key, set: { description } });
  }

  // Mirror the in-code matrix so permissions are reportable from SQL.
  await db.delete(rolePermissions);
  for (const [roleKey, perms] of Object.entries(ROLE_PERMISSIONS)) {
    for (const permissionKey of perms) {
      await db
        .insert(rolePermissions)
        .values({ roleKey: roleKey as keyof typeof ROLE_LABELS, permissionKey })
        .onConflictDoNothing();
    }
  }
  console.log("  roles & permissions seeded");
}

async function seedCatalogue(): Promise<void> {
  let categoryCount = 0;
  let productCount = 0;

  const groups = [
    { department: "DAIRY" as const, entries: DAIRY_CATALOGUE },
    { department: "BAKERY" as const, entries: BAKERY_CATALOGUE },
  ];

  for (const group of groups) {
    for (const [index, entry] of group.entries.entries()) {
      const categorySlug = slugify(`${group.department}-${entry.category}`);
      const [category] = await db
        .insert(productCategories)
        .values({
          department: group.department,
          name: entry.category,
          slug: categorySlug,
          sortOrder: index,
        })
        .onConflictDoUpdate({
          target: productCategories.slug,
          set: { name: entry.category, sortOrder: index },
        })
        .returning();
      categoryCount += 1;

      for (const item of entry.items) {
        await db
          .insert(products)
          .values({
            categoryId: category.id,
            name: item,
            slug: slugify(item),
            unit: entry.unit,
            unitSizeMilli: 1000,
            subscribable: entry.subscribable,
          })
          .onConflictDoUpdate({
            target: products.slug,
            set: { categoryId: category.id, subscribable: entry.subscribable },
          });
        productCount += 1;
      }
    }
  }
  console.log(`  catalogue seeded: ${categoryCount} categories, ${productCount} products`);
}

/**
 * Standard goods for every shop type OTHER than DAIRY and BAKERY, which keep
 * their hand-curated catalogues above. One category per shop type (named
 * after the shop type itself), one product per typical good listed for it.
 *
 * Product slugs are prefixed with the category slug (unlike the DAIRY/BAKERY
 * catalogue, whose product slugs are bare) so that a generic good name that
 * recurs across shop types — "Eggs" appears under Convenience Store, Meat
 * Shop and Poultry Supply Store alike — never collides with another type's
 * product of the same name.
 */
async function seedGeneralCatalogue(): Promise<void> {
  let categoryCount = 0;
  let productCount = 0;

  const excluded = new Set(["DAIRY", "BAKERY"]);

  for (const shopType of SHOP_TYPES) {
    if (excluded.has(shopType.key)) continue;

    const categorySlug = slugify(shopType.label);
    const [category] = await db
      .insert(productCategories)
      .values({
        department: shopType.key,
        name: shopType.label,
        slug: categorySlug,
        description: `Standard goods for a ${shopType.label.toLowerCase()}.`,
        sortOrder: 0,
      })
      .onConflictDoUpdate({
        target: productCategories.slug,
        set: { name: shopType.label, department: shopType.key },
      })
      .returning();
    categoryCount += 1;

    for (const good of shopType.standardGoods) {
      const productSlug = `${categorySlug}-${slugify(good)}`;
      await db
        .insert(products)
        .values({
          categoryId: category.id,
          name: good,
          slug: productSlug,
          unit: "unit",
          unitSizeMilli: 1000,
          // The daily-subscription model is specific to dairy/bakery delivery;
          // general goods are not offered as subscriptions.
          subscribable: false,
        })
        .onConflictDoUpdate({
          target: products.slug,
          set: { categoryId: category.id, name: good },
        });
      productCount += 1;
    }
  }
  console.log(
    `  general catalogue seeded: ${categoryCount} shop-type categories, ${productCount} standard goods`,
  );
}

/** Demonstration shops so the marketplace is browsable immediately. */
async function seedDemoMarketplace(): Promise<void> {
  const demoShops = [
    {
      email: "kesari.dairy@example.com",
      name: "Kesari Dairy Farm",
      shopType: "DAIRY" as const,
      classification: "KESARI" as const,
      area: "Kothrud",
      pincode: "411038",
      picks: ["cow-milk", "buffalo-milk", "fresh-curd", "masala-buttermilk", "fresh-paneer", "cow-ghee"],
    },
    {
      email: "green.dairy@example.com",
      name: "Green Valley Dairy",
      shopType: "DAIRY" as const,
      classification: "GREEN" as const,
      area: "Baner",
      pincode: "411045",
      picks: ["toned-milk", "full-cream-milk", "greek-curd", "salted-butter", "rose-milk"],
    },
    {
      email: "sunrise.bakery@example.com",
      name: "Sunrise Bakery",
      shopType: "BAKERY" as const,
      classification: "GREEN" as const,
      area: "Deccan",
      pincode: "411004",
      picks: ["white-bread", "brown-bread", "pav", "veg-puff", "butter-khari", "chocolate-pastry"],
    },
    {
      email: "anand.combo@example.com",
      name: "Anand Dairy & Bakery",
      // A shop now has one primary type (BOTH was retired). Kept as DAIRY —
      // it still lists both dairy and bakery products via `picks` below.
      shopType: "DAIRY" as const,
      classification: "KESARI" as const,
      area: "Viman Nagar",
      pincode: "411014",
      picks: ["cow-milk", "fresh-curd", "white-bread", "burger-bun", "glazed-donut", "vanilla-sponge"],
    },
    {
      email: "pending.shop@example.com",
      name: "New Milk Corner",
      shopType: "DAIRY" as const,
      classification: null,
      area: "Hadapsar",
      pincode: "411028",
      picks: [],
      status: "PENDING_APPROVAL" as const,
    },
  ];

  // Deterministic pricing so the demo data is stable across runs.
  const basePrices: Record<string, { online: number; offline: number }> = {
    "cow-milk": { online: 7000, offline: 6500 },
    "buffalo-milk": { online: 8000, offline: 7500 },
    "toned-milk": { online: 5600, offline: 5200 },
    "full-cream-milk": { online: 7800, offline: 7400 },
    "fresh-curd": { online: 6000, offline: 5500 },
    "greek-curd": { online: 12000, offline: 11000 },
    "masala-buttermilk": { online: 3000, offline: 2500 },
    "fresh-paneer": { online: 42000, offline: 40000 },
    "cow-ghee": { online: 78000, offline: 75000 },
    "salted-butter": { online: 56000, offline: 54000 },
    "rose-milk": { online: 3500, offline: 3000 },
    "white-bread": { online: 4500, offline: 4000 },
    "brown-bread": { online: 5500, offline: 5000 },
    pav: { online: 3000, offline: 2500 },
    "burger-bun": { online: 4000, offline: 3500 },
    "veg-puff": { online: 2500, offline: 2000 },
    "butter-khari": { online: 3500, offline: 3000 },
    "chocolate-pastry": { online: 8000, offline: 7500 },
    "glazed-donut": { online: 6000, offline: 5500 },
    "vanilla-sponge": { online: 45000, offline: 42000 },
  };

  for (const demo of demoShops) {
    const [owner] = await db
      .insert(users)
      .values({ email: demo.email, name: `${demo.name} Owner`, role: "SHOP_OWNER" })
      .onConflictDoUpdate({ target: users.email, set: { role: "SHOP_OWNER" } })
      .returning();
    await db.insert(wallets).values({ userId: owner.id }).onConflictDoNothing();

    const slug = slugify(demo.name);
    const status = demo.status ?? "APPROVED";
    const [shop] = await db
      .insert(shops)
      .values({
        ownerId: owner.id,
        name: demo.name,
        slug,
        ownerName: `${demo.name} Owner`,
        phone: "9876543210",
        email: demo.email,
        addressLine1: `Shop 1, ${demo.area} Main Road`,
        area: demo.area,
        city: "Pune",
        state: "Maharashtra",
        pincode: demo.pincode,
        shopType: demo.shopType,
        status,
        classification: demo.classification,
        deliveryAvailable: true,
        deliveryFeePaise: 2000,
        freeDeliveryAbovePaise: 30000,
        description: `${demo.name} — fresh products delivered daily in ${demo.area}.`,
        openingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
          day,
          open: "06:00",
          close: "22:00",
        })),
        approvedAt: status === "APPROVED" ? new Date() : null,
      })
      .onConflictDoUpdate({
        target: shops.slug,
        set: { status, classification: demo.classification },
      })
      .returning();

    for (const productSlug of demo.picks) {
      const product = await db.query.products.findFirst({
        where: eq(products.slug, productSlug),
      });
      if (!product) continue;

      const price = basePrices[productSlug] ?? { online: 5000, offline: 4500 };
      await db
        .insert(shopProducts)
        .values({
          shopId: shop.id,
          productId: product.id,
          onlinePricePaise: price.online,
          offlinePricePaise: price.offline,
          onlineSaleEnabled: true,
          offlineSaleEnabled: true,
          trackInventory: true,
          onlineStock: 500,
          offlineStock: 200,
          isActive: true,
          isAvailable: true,
        })
        .onConflictDoUpdate({
          target: [shopProducts.shopId, shopProducts.productId],
          set: {
            onlinePricePaise: price.online,
            offlinePricePaise: price.offline,
            onlineStock: 500,
          },
        });
    }
  }

  // One deliberately offline-only product, so the §14 rule is visible in the UI.
  const paneer = await db.query.products.findFirst({
    where: eq(products.slug, "malai-paneer"),
  });
  const kesari = await db.query.shops.findFirst({
    where: eq(shops.slug, "kesari-dairy-farm"),
  });
  if (paneer && kesari) {
    await db
      .insert(shopProducts)
      .values({
        shopId: kesari.id,
        productId: paneer.id,
        onlineSaleEnabled: false,
        onlinePricePaise: null,
        offlineSaleEnabled: true,
        offlinePricePaise: 45000,
        trackInventory: false,
        isActive: true,
        isAvailable: true,
      })
      .onConflictDoUpdate({
        target: [shopProducts.shopId, shopProducts.productId],
        set: { onlineSaleEnabled: false, onlinePricePaise: null },
      });
  }

  // Each demo shop carries its department's categories plus the categories of
  // what it lists — the same rule migration 0038 used for existing shops.
  await db.execute(sql`
    INSERT INTO shop_product_categories (shop_id, category_id)
    SELECT s.id, c.id FROM shops s
      JOIN product_categories c ON c.department::text = s.shop_type::text AND c.deleted_at IS NULL
     WHERE s.deleted_at IS NULL
    UNION
    SELECT DISTINCT sp.shop_id, p.category_id FROM shop_products sp JOIN products p ON p.id = sp.product_id
     WHERE sp.deleted_at IS NULL
    ON CONFLICT (shop_id, category_id) DO NOTHING`);

  console.log(`  demo marketplace seeded: ${demoShops.length} shops`);
}

async function main() {
  const minimal = process.argv.includes("--minimal");
  console.log(`Seeding database${minimal ? " (reference data only)" : ""}…`);

  await seedRolesAndPermissions();
  await ensureGeneralCategory();
  await seedCatalogue();
  await seedGeneralCatalogue();
  if (!minimal) await seedDemoMarketplace();

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(products);
  console.log(`Done. ${count} products in catalogue.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
