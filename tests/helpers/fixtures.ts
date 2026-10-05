/**
 * Integration-test fixtures.
 *
 * Builds real rows in the real test database so tests exercise the same
 * constraints and locking behaviour as production.
 */
import { eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  addresses,
  deliveryPartners,
  orders,
  payments,
  productCategories,
  products,
  shopProductCategories,
  shopProducts,
  shops,
  users,
  vouchers,
  wallets,
  type DeliveryPartnerStatus,
  type Department,
  type OrderStatus,
  type UserRole,
} from "@/server/db/schema";
import type { ShopTypeKey } from "@/lib/shop-types";
import type { VehicleTypeKey } from "@/lib/vehicle-types";

let counter = 0;
const uniq = () => `${Date.now().toString(36)}-${(counter += 1)}`;

/** Postgres deadlock_detected / lock_not_available — both are worth a retry. */
const RETRYABLE_LOCK_ERRORS = new Set(["40P01", "55P03"]);

function pgErrorCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } };
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Wipes all business data between tests. Order is handled by CASCADE.
 *
 * Retried on deadlock: TRUNCATE takes an AccessExclusiveLock on every table
 * listed, which deadlocks against a connection from the previous test that is
 * still winding down while holding row locks. Postgres resolves it by killing
 * one side — usually this one — so a retry succeeds. Without the retry the
 * suite fails intermittently during cleanup rather than on anything a test
 * actually asserts, which masks real regressions.
 */
export async function resetDatabase(): Promise<void> {
  const maxAttempts = 5;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await db.execute(sql`
        TRUNCATE TABLE
          grievances, user_consents,
          delivery_partner_earnings, delivery_earnings_config, delivery_orders,
          maps_api_call_log, delivery_partners,
          audit_logs, notifications,
          price_update_requests, price_update_batches,
          excel_upload_items, excel_uploads,
          shop_payments, referral_redemptions, referral_codes,
          registration_fee_history, registration_fees,
          voucher_redemptions, voucher_upload_items, voucher_uploads, vouchers,
          subscription_orders, subscription_daily_overrides, subscriptions,
          wallet_transactions, wallets, payments,
          order_status_history, order_items, orders,
          cart_items, carts,
          stock_alerts, inventory_movements, product_price_history, shop_products,
          product_images, product_mrp_history, products,
          product_subcategories, product_categories, brands,
          delivery_partner_change_requests, delivery_slot_capacities, order_groups, status_changes, seller_verification_files, seller_verification_events, seller_verifications,
          shop_classification_history, shops,
          addresses,
          sessions, accounts, users
        RESTART IDENTITY CASCADE
      `);
      return;
    } catch (error) {
      const code = pgErrorCode(error);
      if (!code || !RETRYABLE_LOCK_ERRORS.has(code) || attempt >= maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 150));
    }
  }
}

let mobileCounter = 0;
/** A unique, valid Indian mobile number per call (buyers need one to check out). */
export function uniqueMobile(): string {
  mobileCounter += 1;
  return `9${String(Date.now() % 1e5).padStart(5, "0")}${String(mobileCounter % 1e4).padStart(4, "0")}`;
}

export async function createUser(
  overrides: { email?: string; role?: UserRole; name?: string; mobile?: string | null } = {},
) {
  const mobile = overrides.mobile === undefined ? uniqueMobile() : overrides.mobile;
  const [user] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${uniq()}@test.local`,
      name: overrides.name ?? "Test User",
      role: overrides.role ?? "CUSTOMER",
      phoneE164: mobile ? `+91${mobile}` : null,
      phone: mobile,
    })
    .returning();
  return user;
}

/**
 * The user's default delivery address, created on first use. PIN 411001 is the
 * test shops' own PIN, so every fixture shop delivers to it. Personal orders
 * from a shop that delivers need an address (checkout refuses without one).
 */
export async function deliveryAddressId(userId: string): Promise<string> {
  const [existing] = await db
    .select({ id: addresses.id })
    .from(addresses)
    .where(sql`${addresses.userId} = ${userId} AND ${addresses.isDefault} AND ${addresses.deletedAt} IS NULL`)
    .limit(1);
  if (existing) return existing.id;
  const [address] = await db
    .insert(addresses)
    .values({ userId, line1: "2 Test Lane", city: "Pune", pincode: "411001", isDefault: true, addressType: "HOME" })
    .returning({ id: addresses.id });
  return address.id;
}

export async function createUserWithWallet(
  overrides: { email?: string; role?: UserRole; balancePaise?: number; mobile?: string | null } = {},
) {
  const user = await createUser(overrides);
  const [wallet] = await db
    .insert(wallets)
    .values({ userId: user.id, balancePaise: overrides.balancePaise ?? 0 })
    .returning();
  return { user, wallet };
}

export async function createCategory(
  overrides: { department?: Department; name?: string } = {},
) {
  const name = overrides.name ?? "Milk";
  // Category names are unique (ignoring case) among live categories, so a
  // second call with the same name reuses the first category.
  const [existing] = await db
    .select()
    .from(productCategories)
    .where(sql`lower(${productCategories.name}) = ${name.toLowerCase()} AND ${productCategories.deletedAt} IS NULL`);
  if (existing) return existing;
  const [category] = await db
    .insert(productCategories)
    .values({
      department: overrides.department ?? "DAIRY",
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${uniq()}`,
    })
    .returning();
  return category;
}

export async function createProduct(
  categoryId: string,
  overrides: { name?: string; unit?: string; subscribable?: boolean } = {},
) {
  const name = overrides.name ?? "Cow Milk";
  const [product] = await db
    .insert(products)
    .values({
      categoryId,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${uniq()}`,
      unit: overrides.unit ?? "L",
      unitSizeMilli: 1000,
      subscribable: overrides.subscribable ?? true,
    })
    .returning();
  return product;
}

export async function createShop(
  ownerId: string,
  overrides: {
    status?: "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "SUSPENDED" | "INACTIVE";
    shopType?: ShopTypeKey;
    classification?: "KESARI" | "GREEN" | null;
    name?: string;
    deliveryAvailable?: boolean;
    deliveryFeePaise?: number;
    freeDeliveryAbovePaise?: number | null;
    registrationFeePaise?: number | null;
    latitude?: number | null;
    longitude?: number | null;
    preparationTimeMinutes?: number;
  } = {},
) {
  const name = overrides.name ?? "Test Dairy";
  const [shop] = await db
    .insert(shops)
    .values({
      ownerId,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${uniq()}`,
      ownerName: "Owner",
      phone: "9999999999",
      addressLine1: "1 Test Road",
      city: "Pune",
      pincode: "411001",
      shopType: overrides.shopType ?? "DAIRY",
      status: overrides.status ?? "APPROVED",
      classification: overrides.classification ?? "KESARI",
      deliveryAvailable: overrides.deliveryAvailable ?? true,
      deliveryFeePaise: overrides.deliveryFeePaise ?? 0,
      freeDeliveryAbovePaise: overrides.freeDeliveryAbovePaise ?? null,
      registrationFeePaise:
        overrides.registrationFeePaise !== undefined
          ? overrides.registrationFeePaise
          : 500_000, // ₹5,000 — the fee used throughout the brief's examples
      latitude: overrides.latitude != null ? String(overrides.latitude) : null,
      longitude: overrides.longitude != null ? String(overrides.longitude) : null,
      preparationTimeMinutes: overrides.preparationTimeMinutes ?? 15,
    })
    .returning();
  return shop;
}

/**
 * Inserts an order row directly, bypassing checkout() — for tests that need a
 * specific status (e.g. WALLET_INSUFFICIENT) that only the subscription
 * engine normally produces, without exercising that whole engine to get
 * there. Money fields default to a simple ₹70 order with no delivery fee.
 */
export async function createOrder(
  userId: string,
  shopId: string,
  overrides: {
    status?: OrderStatus;
    subtotalPaise?: number;
    deliveryFeePaise?: number;
    taxPaise?: number;
    totalPaise?: number;
    paidAt?: Date | null;
    source?: "DIRECT" | "SUBSCRIPTION";
  } = {},
) {
  const subtotalPaise = overrides.subtotalPaise ?? 7000;
  const deliveryFeePaise = overrides.deliveryFeePaise ?? 0;
  const taxPaise = overrides.taxPaise ?? 0;
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `TEST-${uniq()}`,
      userId,
      shopId,
      status: overrides.status ?? "PENDING",
      source: overrides.source ?? "DIRECT",
      subtotalPaise,
      deliveryFeePaise,
      taxPaise,
      totalPaise: overrides.totalPaise ?? subtotalPaise + deliveryFeePaise + taxPaise,
      paidAt: overrides.paidAt !== undefined ? overrides.paidAt : null,
    })
    .returning();
  return order;
}

/**
 * Inserts a delivery partner directly (bypassing registerDeliveryPartner's
 * geocoding call) so assignment/earnings tests can set up an approved,
 * positioned partner in one step.
 */
export async function createDeliveryPartner(
  userId: string,
  overrides: {
    status?: DeliveryPartnerStatus;
    vehicleType?: VehicleTypeKey;
    isOnline?: boolean;
    latitude?: number | null;
    longitude?: number | null;
    operatingRadiusKm?: number;
  } = {},
) {
  const [partner] = await db
    .insert(deliveryPartners)
    .values({
      userId,
      fullName: "Test Rider",
      mobile: "9876543210",
      vehicleType: overrides.vehicleType ?? "MOTORCYCLE",
      status: overrides.status ?? "APPROVED",
      isOnline: overrides.isOnline ?? false,
      operatingRadiusKm: overrides.operatingRadiusKm ?? 5,
      lastLocationLatitude: overrides.latitude != null ? String(overrides.latitude) : null,
      lastLocationLongitude: overrides.longitude != null ? String(overrides.longitude) : null,
      lastLocationAt: overrides.latitude != null ? new Date() : null,
    })
    .returning();
  return partner;
}

export async function createShopProduct(
  shopId: string,
  productId: string,
  overrides: {
    onlinePricePaise?: number | null;
    offlinePricePaise?: number | null;
    onlineSaleEnabled?: boolean;
    offlineSaleEnabled?: boolean;
    onlineStock?: number;
    trackInventory?: boolean;
    isActive?: boolean;
    isAvailable?: boolean;
  } = {},
) {
  const onlineEnabled = overrides.onlineSaleEnabled ?? true;
  // A listing is on sale only while the shop carries the product's category
  // (as migration 0038 backfilled for every existing listing).
  const [product] = await db.select({ categoryId: products.categoryId }).from(products).where(eq(products.id, productId));
  if (product) {
    await db.insert(shopProductCategories).values({ shopId, categoryId: product.categoryId }).onConflictDoNothing();
  }
  const [shopProduct] = await db
    .insert(shopProducts)
    .values({
      shopId,
      productId,
      onlineSaleEnabled: onlineEnabled,
      onlinePricePaise:
        overrides.onlinePricePaise !== undefined
          ? overrides.onlinePricePaise
          : onlineEnabled
            ? 7000
            : null,
      offlineSaleEnabled: overrides.offlineSaleEnabled ?? false,
      offlinePricePaise:
        overrides.offlinePricePaise !== undefined
          ? overrides.offlinePricePaise
          : (overrides.offlineSaleEnabled ?? false)
            ? 6500
            : null,
      onlineStock: overrides.onlineStock ?? 100,
      trackInventory: overrides.trackInventory ?? true,
      isActive: overrides.isActive ?? true,
      isAvailable: overrides.isAvailable ?? true,
    })
    .returning();
  return shopProduct;
}

/** Convenience: an approved dairy shop selling 1 L cow milk online at ₹70. */
export async function createStandardMilkSetup(
  options: { customerBalancePaise?: number } = {},
) {
  const { user: customer, wallet } = await createUserWithWallet({
    balancePaise: options.customerBalancePaise ?? 500_000,
  });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, {
    name: "Cow Milk",
    unit: "L",
    subscribable: true,
  });
  const shop = await createShop(owner.id, { status: "APPROVED" });
  const shopProduct = await createShopProduct(shop.id, product.id, {
    onlinePricePaise: 7000,
    offlinePricePaise: 6500,
    onlineSaleEnabled: true,
    offlineSaleEnabled: true,
    onlineStock: 1000,
  });
  return { customer, wallet, owner, category, product, shop, shopProduct };
}

/** A minimal real payments row — voucher_redemptions.payment_id is a real FK. */
export async function createPayment(
  userId: string,
  overrides: { amountPaise?: number; status?: "CREATED" | "SUCCESS" } = {},
) {
  const [payment] = await db
    .insert(payments)
    .values({
      userId,
      gatewayOrderId: `mock_order_${uniq()}`,
      amountPaise: overrides.amountPaise ?? 100_000,
      status: overrides.status ?? "SUCCESS",
    })
    .returning();
  return payment;
}

export async function createVoucher(
  overrides: {
    name?: string;
    code?: string;
    bonusPercent?: number;
    minimumTopupPaise?: number;
    maximumBonusPaise?: number | null;
    startDate?: string;
    endDate?: string;
    usageLimit?: number | null;
    perCustomerLimit?: number;
    totalBudgetPaise?: number | null;
    status?: "DRAFT" | "ACTIVE" | "PAUSED" | "EXPIRED" | "BUDGET_EXHAUSTED";
    createdBy?: string | null;
  } = {},
) {
  const [voucher] = await db
    .insert(vouchers)
    .values({
      name: overrides.name ?? "Test Voucher",
      code: overrides.code ?? `TEST${uniq().toUpperCase().replace(/[^A-Z0-9]/g, "")}`,
      applyMode: "CODE",
      bonusPercent: overrides.bonusPercent ?? 10,
      minimumTopupPaise: overrides.minimumTopupPaise ?? 0,
      maximumBonusPaise: overrides.maximumBonusPaise ?? null,
      startDate: overrides.startDate ?? "2020-01-01",
      endDate: overrides.endDate ?? "2099-12-31",
      usageLimit: overrides.usageLimit ?? null,
      perCustomerLimit: overrides.perCustomerLimit ?? 1,
      totalBudgetPaise: overrides.totalBudgetPaise ?? null,
      status: overrides.status ?? "ACTIVE",
      createdBy: overrides.createdBy ?? null,
    })
    .returning();
  return voucher;
}

/** The shop carries this product category, so it sees (and may sell) the category's products. */
export async function linkShopCategory(shopId: string, categoryId: string) {
  await db.insert(shopProductCategories).values({ shopId, categoryId }).onConflictDoNothing();
}
