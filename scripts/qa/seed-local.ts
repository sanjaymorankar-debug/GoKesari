/**
 * Creates the QA suite's test data in a LOCAL database — every account, shop
 * and listing of the "Test data" sheet of test-cases.xlsx — and writes the
 * world file the specs read (test-results/qa/world-<host>.json).
 *
 *   DATABASE_URL=postgresql://…@localhost:5432/gk_qa AUTH_SECRET=… CRON_SECRET=… \
 *     npx tsx scripts/qa/seed-local.ts [--base-url http://localhost:3000]
 *
 * Refuses any database that is not on this machine. Each run adds a fresh set
 * (emails carry the run id), so runs never share state.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { addresses, deliveryPartners, products, shops, societies, societyMembers, users, wallets } from "@/server/db/schema";
import { recordConsent } from "@/server/services/consents";
import { grantRole } from "@/server/services/roles";
import type { UserRole } from "@/server/db/schema";

import {
  createCategory,
  createDeliveryPartner,
  createShop,
  createShopProduct,
  createUser,
  verifySellerDocuments,
} from "../../tests/helpers/fixtures";

const args = process.argv.slice(2);
const baseUrl = args[args.indexOf("--base-url") + 1] && args.includes("--base-url") ? args[args.indexOf("--base-url") + 1] : "http://localhost:3000";
const host = new URL(baseUrl).host;

const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.error("seed-local: DATABASE_URL must be a database on this machine (localhost). Refusing.");
  process.exit(2);
}

const RUN = Date.now().toString(36);
/** Kothrud, Pune — shop A, its customer and its riders sit here. */
const HOME = { pincode: "411038", lat: 18.5074, lng: 73.8077 };
/** Hinjewadi — about 12 km away, outside a 5 km radius and no shop's PIN. */
const FAR = { pincode: "411057", lat: 18.5913, lng: 73.7389 };

let mobileSeq = 0;
function mobile() {
  mobileSeq += 1;
  return `8${String(Date.now() % 1e6).padStart(6, "0")}${String(mobileSeq).padStart(3, "0")}`;
}

async function person(label: string, role: UserRole, opts: { withMobile?: boolean; name?: string } = {}) {
  const email = `qa-${label}-${RUN}@test.local`;
  const phone = opts.withMobile === false ? null : mobile();
  const user = await createUser({ email, role, name: opts.name ?? `QA ${label}`, mobile: phone });
  await db
    .update(users)
    .set({
      profileCompletedAt: new Date(),
      emailVerified: new Date(),
      ...(phone ? { phoneVerifiedAt: new Date() } : {}),
    })
    .where(eq(users.id, user.id));
  if (role !== "CUSTOMER") await grantRole(user.id, role, { source: "ADMIN" });
  await recordConsent(user.id, "TERMS_AND_PRIVACY");
  return { id: user.id, email, mobile: phone };
}

/** A wallet whose balance and ledger agree, as a settled top-up leaves them. */
async function fund(userId: string, amountPaise: number) {
  await db.insert(wallets).values({ userId, balancePaise: 0 }).onConflictDoNothing();
  await db.execute(sql`
    with w as (select id, balance_paise from wallets where user_id = ${userId} for update)
    , upd as (update wallets set balance_paise = balance_paise + ${amountPaise}, updated_at = now() where id = (select id from w) returning id)
    insert into wallet_transactions (wallet_id, user_id, type, amount_paise, previous_balance_paise, new_balance_paise, idempotency_key, description)
    select w.id, ${userId}, 'TOP_UP', ${amountPaise}, w.balance_paise, w.balance_paise + ${amountPaise}, ${"qa-topup-" + RUN + "-" + userId}, 'QA seed top-up'
    from w`);
}

async function address(userId: string, at: { pincode: string; lat: number; lng: number }, line1: string) {
  const [row] = await db
    .insert(addresses)
    .values({
      userId,
      line1,
      area: "Kothrud",
      city: "Pune",
      state: "Maharashtra",
      pincode: at.pincode,
      latitude: String(at.lat),
      longitude: String(at.lng),
      addressType: "HOME",
      recipientName: "QA Recipient",
      isDefault: true,
      locationVerified: true,
      locationVerifiedAt: new Date(),
      locationSource: "MANUAL_ENTRY",
    })
    .returning({ id: addresses.id });
  return row.id;
}

async function shop(ownerId: string, name: string, at: { lat: number; lng: number }, status: "APPROVED" | "PENDING_APPROVAL" = "APPROVED") {
  const row = await createShop(ownerId, { name, status, latitude: at.lat, longitude: at.lng, registrationFeePaise: 0 });
  await db
    .update(shops)
    .set({
      pincode: HOME.pincode,
      area: "Kothrud",
      serviceRadiusKm: 5,
      codEnabled: false,
      locationVerified: true,
      locationVerifiedAt: new Date(),
      locationSource: "MANUAL_ENTRY",
      ...(status === "APPROVED" ? { approvedAt: new Date(), profileCompletedAt: new Date() } : {}),
    })
    .where(eq(shops.id, row.id));
  if (status === "APPROVED") await verifySellerDocuments(row.id);
  const [fresh] = await db.select({ id: shops.id, slug: shops.slug, name: shops.name, pincode: shops.pincode }).from(shops).where(eq(shops.id, row.id));
  return { id: fresh.id, slug: fresh.slug, name: fresh.name, pincode: fresh.pincode ?? HOME.pincode };
}

async function product(categoryId: string, name: string, opts: { unit?: string; kind?: "PACKAGED" | "LOOSE"; mrpPaise?: number | null; subscribable?: boolean } = {}) {
  const [row] = await db
    .insert(products)
    .values({
      categoryId,
      name,
      slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${RUN}`,
      unit: opts.unit ?? "piece",
      unitSizeMilli: 1000,
      subscribable: opts.subscribable ?? false,
      kind: opts.kind ?? "PACKAGED",
      ...(opts.mrpPaise != null
        ? { mrpPaise: opts.mrpPaise, mrpSource: "ADMIN" as const, mrpVerificationStatus: "VERIFIED" as const, mrpUpdatedAt: new Date() }
        : {}),
      approvalStatus: "APPROVED",
      isActive: true,
    })
    .returning({ id: products.id, name: products.name });
  return row;
}

async function main() {
  // Accounts (the "Test data" sheet).
  const customer = await person("customer", "CUSTOMER", { name: "QA Customer One" });
  const customer2 = await person("customer2", "CUSTOMER", { withMobile: false, name: "QA Customer Two" });
  const owner = await person("shop", "SHOP_OWNER", { name: "QA Owner A" });
  const ownerB = await person("shopb", "SHOP_OWNER", { name: "QA Owner B" });
  const ownerC = await person("shopc", "SHOP_OWNER", { name: "QA Owner C" });
  const ownerPending = await person("pending", "SHOP_OWNER", { name: "QA Owner Pending" });
  const rider = await person("rider", "DELIVERY_PARTNER", { name: "QA Rider One" });
  const rider2 = await person("rider2", "DELIVERY_PARTNER", { name: "QA Rider Two" });
  const admin = await person("admin", "ADMIN", { name: "QA Admin" });
  const ops = await person("ops", "OPERATOR", { name: "QA Operator" });
  const oplim = await person("oplim", "OPERATOR_LIMITED", { name: "QA Operator Limited" });
  const societyAdmin = await person("society", "SOCIETY_ADMIN", { name: "QA Society Admin" });

  await fund(customer.id, 500_000); // Rs 5,000
  await fund(customer2.id, 200_000);
  await fund(owner.id, 100_000);
  await recordConsent(customer.id, "MARKETING_COMMUNICATIONS", { granted: true });

  const addr1 = await address(customer.id, { pincode: HOME.pincode, lat: HOME.lat + 0.009, lng: HOME.lng }, "QA Flat 1, Karve Road");
  const addr2 = await address(customer2.id, FAR, "QA House 9, Phase 1");

  // Shops A and B in the same PIN; C approved and empty; one pending.
  const A = await shop(owner.id, `QA Shop A ${RUN}`, HOME);
  const B = await shop(ownerB.id, `QA Shop B ${RUN}`, { lat: HOME.lat - 0.0024, lng: HOME.lng + 0.0023 });
  const C = await shop(ownerC.id, `QA Shop C ${RUN}`, { lat: HOME.lat + 0.002, lng: HOME.lng - 0.002 });
  const P = await shop(ownerPending.id, `QA Pending Shop ${RUN}`, HOME, "PENDING_APPROVAL");

  // Catalogue: one QA category with each kind of product the cases name.
  const category = await createCategory({ department: "DAIRY", name: `QA Dairy ${RUN}` });
  const butter = await product(category.id, `QA Butter 100 g ${RUN}`, { mrpPaise: 6000 });
  const milk = await product(category.id, `QA Cow Milk 1 L ${RUN}`, { unit: "L", subscribable: true, mrpPaise: 7200 });
  const paneer = await product(category.id, `QA Loose Paneer ${RUN}`, { unit: "kg", kind: "LOOSE" });
  const sugar = await product(category.id, `QA Loose Sugar ${RUN}`, { unit: "kg", kind: "LOOSE" });
  const bread = await product(category.id, `QA Bread ${RUN}`, { mrpPaise: 5000 });
  const ghee = await product(category.id, `QA Ghee 1 L ${RUN}`, { unit: "L", mrpPaise: 70000 });
  const curd = await product(category.id, `QA Curd 400 g ${RUN}`, { mrpPaise: 4000 });

  const listing = async (shopId: string, productId: string, name: string, price: number | null, stock: number, extra: Parameters<typeof createShopProduct>[2] = {}) => {
    const row = await createShopProduct(shopId, productId, { onlinePricePaise: price, onlineStock: stock, ...extra });
    return { shopProductId: row.id, productId, name, pricePaise: price, stock };
  };
  const packaged = { ...(await listing(A.id, butter.id, butter.name, 5800, 50)), mrpPaise: 6000 };
  const milkA = await listing(A.id, milk.id, milk.name, 7000, 500);
  const loose = await listing(A.id, paneer.id, paneer.name, 40000, 40);
  // A loose product added without a price is not on sale online until the owner prices it (NEW-008).
  const unpricedLoose = await listing(A.id, sugar.id, sugar.name, null, 100, { onlineSaleEnabled: false });
  const sharedA = { ...(await listing(A.id, bread.id, bread.name, 4000, 60)), mrpPaise: 5000 };
  const sharedB = { ...(await listing(B.id, bread.id, bread.name, 4500, 60)), mrpPaise: 5000 };
  const lowStock = await listing(A.id, curd.id, curd.name, 3500, 2);
  // A pricey packaged line: a basket that outgrows a wallet in a few units (TC-CART-011).
  const premium = { ...(await listing(A.id, ghee.id, ghee.name, 65000, 30)), mrpPaise: 70000 };
  const offlineRow = await createShopProduct(B.id, ghee.id, { onlineSaleEnabled: false, onlinePricePaise: null, offlineSaleEnabled: true, offlinePricePaise: 65000, onlineStock: 10 });
  const offlineOnly = { shopProductId: offlineRow.id, productId: ghee.id, name: ghee.name, pricePaise: null, stock: 10 };

  // Riders: one at shop A, one about 3 km away. Both approved and online.
  // Riders of earlier worlds go offline, so offers reach this world's riders only.
  await db.update(deliveryPartners).set({ isOnline: false }).where(eq(deliveryPartners.isOnline, true));
  const riderPartner = await createDeliveryPartner(rider.id, { status: "APPROVED", isOnline: true, latitude: HOME.lat + 0.001, longitude: HOME.lng + 0.001, operatingRadiusKm: 10 });
  const rider2Partner = await createDeliveryPartner(rider2.id, { status: "APPROVED", isOnline: true, latitude: HOME.lat + 0.027, longitude: HOME.lng, operatingRadiusKm: 10 });
  // The fixture gives every partner one mobile; each rider keeps their own, so a lookup by mobile finds one rider.
  for (const [partner, account] of [[riderPartner, rider], [rider2Partner, rider2]] as const) {
    await db.update(deliveryPartners).set({ mobile: account.mobile! }).where(eq(deliveryPartners.id, partner.id));
  }

  // A verified society inside shop A's zone, with its admin.
  const [society] = await db
    .insert(societies)
    .values({
      name: `QA Society ${RUN}`,
      addressLine1: "QA Society Road",
      slug: `qa-society-${RUN}`,
      area: "Kothrud",
      city: "Pune",
      pincode: HOME.pincode,
      latitude: String(HOME.lat + 0.004),
      longitude: String(HOME.lng),
      status: "VERIFIED",
      registeredBy: societyAdmin.id,
      verifiedBy: admin.id,
      verifiedAt: new Date(),
    })
    .returning({ id: societies.id, name: societies.name });
  await db.insert(societyMembers).values({ societyId: society.id, userId: societyAdmin.id, role: "ADMIN", status: "ACTIVE", approvedBy: admin.id, approvedAt: new Date() });

  const world = {
    target: "local",
    host,
    createdAt: new Date().toISOString(),
    run: RUN,
    users: { customer, customer2, shop: owner, shopB: ownerB, shopC: ownerC, rider, rider2, admin, ops, oplim, society: societyAdmin, pending: ownerPending },
    shops: { A, B, C, pending: P },
    listings: { packaged, milk: milkA, loose, unpricedLoose, sharedA, sharedB, offlineOnly, lowStock, premium },
    society,
    category: { id: category.id, name: category.name },
    location: HOME,
    outsidePincode: FAR.pincode,
    addresses: { customer: addr1, customer2: addr2 },
  };
  const file = join("test-results", "qa", `world-${host.replace(/[^a-z0-9.-]/gi, "_")}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(world, null, 2));
  console.log(`seed-local: world ${RUN} written to ${file} (${Object.keys(world.users).length} accounts, 4 shops, 9 listings)`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
