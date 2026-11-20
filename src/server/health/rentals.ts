/**
 * GoKesari Health: medical equipment stores and rentals (owner brief §2.7, §4.3).
 *
 *  - Store (shop type MEDICAL_EQUIPMENT, or any shop that rents equipment): a profile with rental terms,
 *    damage policy and delivery radius, verified by GoKesari staff; listings from the equipment master or
 *    custom — for sale and / or rent per day / week / month, minimum period, deposit, delivery and
 *    installation charge, stock, prescription-required flag. Buying is the normal GoKesari order: a
 *    listing may point at the store's shop product and "Buy" opens that product page.
 *  - Rental: the patient chooses the period, start date, saved address, quantity, the family member and
 *    a doctor's prescription or equipment suggestion (required for prescription-only equipment). Totals
 *    are worked out here (rent + deposit + delivery). Paid online only (purpose HEALTH_RENTAL); capture
 *    confirms it and takes the stock.
 *  - Lifecycle: CONFIRMED → OUT_FOR_DELIVERY → delivered with the patient's delivery code → ACTIVE
 *    (due-date reminder scheduled) → extension (another payment; due date moves) → RETURN_SCHEDULED →
 *    RETURNED → condition check, damages (≤ deposit), deposit refund (deposit − damages) → CLOSED (stock
 *    back). Cancel before delivery: full refund. Disputes open a support ticket.
 *  - Settlement: rent + delivery (and damages kept, at close) are credited to the store as
 *    financial_adjustments, less GoKesari's commission (rule health.rentalCommissionBp, fixed on the
 *    rental); the deposit is never credited. Keys healthrent:<id>:credit|commission:<n>.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { z } from "zod";

import { commissionOnFee } from "@/lib/consult/policy";
import { addDays, formatDateKey, formatSlot, istAt, istDateKey } from "@/lib/consult/time";
import { getEnv } from "@/lib/env";
import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { formatDistance } from "@/lib/geo/nearby";
import { RENTAL_STATUS_LABELS, RENTAL_UNITS, type RentalStatus, type RentalUnit } from "@/lib/health/constants";
import { db, type DbClient } from "@/server/db";
import {
  addresses,
  financialAdjustments,
  healthEquipmentListings,
  healthEquipmentMaster,
  healthEquipmentStoreProfiles,
  healthPatients,
  healthPrescriptions,
  healthRentals,
  healthSuggestions,
  paymentIntents,
  paymentRefunds,
  scheduledNotices,
  shopProducts,
  shops,
  supportTickets,
  users,
  type HealthEquipmentListing,
  type HealthEquipmentMaster,
  type HealthEquipmentStoreProfile,
  type HealthRental,
  type PaymentIntentRow,
  type RentalExtension,
  type ScheduledNotice,
} from "@/server/db/schema";
import type { PaymentIntentRef } from "@/server/payments/intents";
import type { AfterCommit } from "@/server/payments/purpose-handlers";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify, NOTIFICATION_TYPES } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { isHealthStaff, patientAudience, requireHealthEnabled, requirePatientAccess, type HealthActor } from "./access";
import { publishHealthEvent, type HealthEventName } from "./events";
import { addTimeline, nextNumber } from "./timeline";

export const RENTAL_DUE_KIND = "HEALTH_RENTAL_DUE";
export const RENTAL_PATH = "/health/equipment/rentals";
export const STORE_RENTAL_PATH = "/shop/health/equipment/rentals";
const UNIT_DAYS: Record<RentalUnit, number> = { DAY: 1, WEEK: 7, MONTH: 30 };
const UNIT_LABEL: Record<RentalUnit, [string, string]> = { DAY: ["day", "days"], WEEK: ["week", "weeks"], MONTH: ["month", "months"] };
const NUMBER = /^\s*-?\d{1,3}(\.\d+)?\s*$/;

export const periodText = (unit: string, count: number) => `${count} ${UNIT_LABEL[unit as RentalUnit]?.[count === 1 ? 0 : 1] ?? unit.toLowerCase()}`;

function unitPrice(listing: Pick<HealthEquipmentListing, "rentDayPaise" | "rentWeekPaise" | "rentMonthPaise">, unit: RentalUnit): number | null {
  const v = unit === "DAY" ? listing.rentDayPaise : unit === "WEEK" ? listing.rentWeekPaise : listing.rentMonthPaise;
  return v && v > 0 ? v : null;
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const coord = (v: string | number | null | undefined): number | null => (v == null ? null : typeof v === "number" ? v : NUMBER.test(v) ? Number(v) : null);

/* ------------------------------------------------------------ delivery code */

/** The patient's 4-digit delivery code: HMAC(AUTH_SECRET, salt + rental) — never stored. */
export function deliveryCode(rentalId: string, salt: string): string {
  const mac = createHmac("sha256", getEnv().AUTH_SECRET).update(`rental-otp:${salt}:${rentalId}`).digest();
  return String(mac.readUInt32BE(0) % 10_000).padStart(4, "0");
}

function deliveryCodeMatches(rentalId: string, salt: string, entered: string | null | undefined): boolean {
  const clean = (entered ?? "").replace(/\D/g, "");
  if (clean.length !== 4) return false;
  const want = Buffer.from(deliveryCode(rentalId, salt));
  const got = Buffer.from(clean);
  return want.length === got.length && timingSafeEqual(want, got);
}

/* ------------------------------------------------------------ store access and profile */

/** The store's owner or GoKesari Health staff. Anyone else: 404. */
async function requireStoreAccess(shopId: string, actor: HealthActor, client: DbClient = db) {
  if (!/^[0-9a-f-]{36}$/i.test(shopId)) throw notFound("Store");
  const [s] = await client.select().from(shops).where(eq(shops.id, shopId));
  if (!s || s.deletedAt) throw notFound("Store");
  if (s.ownerId === actor.id) return { shop: s, role: "OWNER" as const };
  if (isHealthStaff(actor)) return { shop: s, role: "STAFF" as const };
  throw notFound("Store");
}

/** Which store a seller-side equipment page is about: ?shopId=, else the owner's equipment store, else their active shop. */
export async function equipmentStoreForPage(actor: HealthActor, requested?: string | null): Promise<{ shopId: string; shopName: string; shopType: string } | null> {
  if (requested && /^[0-9a-f-]{36}$/i.test(requested)) {
    const ok = await requireStoreAccess(requested, actor).catch(() => null);
    if (ok) return { shopId: ok.shop.id, shopName: ok.shop.name, shopType: ok.shop.shopType };
  }
  const owned = await db.select({ id: shops.id, name: shops.name, shopType: shops.shopType }).from(shops).where(and(eq(shops.ownerId, actor.id), isNull(shops.deletedAt))).orderBy(asc(shops.createdAt));
  const pick = owned.find((s) => s.shopType === "MEDICAL_EQUIPMENT") ?? owned[0];
  return pick ? { shopId: pick.id, shopName: pick.name, shopType: pick.shopType } : null;
}

export const storeProfileInput = z.object({
  rentalTerms: z.string().trim().max(3000).nullish(),
  damagePolicy: z.string().trim().max(3000).nullish(),
  deliveryRadiusKm: z.number().int().min(1).max(100).default(10),
});

/** Saves the store's rental terms; a new (or rejected and edited) profile waits for GoKesari's verification. */
export async function saveEquipmentStoreProfile(shopId: string, raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<HealthEquipmentStoreProfile> {
  await requireHealthEnabled();
  const input = storeProfileInput.parse(raw);
  await requireStoreAccess(shopId, actor);
  const [existing] = await db.select().from(healthEquipmentStoreProfiles).where(eq(healthEquipmentStoreProfiles.shopId, shopId));
  const values = { rentalTerms: input.rentalTerms || null, damagePolicy: input.damagePolicy || null, deliveryRadiusKm: input.deliveryRadiusKm, updatedAt: now };
  if (existing) {
    const [u] = await db
      .update(healthEquipmentStoreProfiles)
      .set({ ...values, ...(existing.verification === "REJECTED" ? { verification: "PENDING", verificationNote: null } : {}) })
      .where(eq(healthEquipmentStoreProfiles.shopId, shopId))
      .returning();
    if (existing.verification === "REJECTED") await publishHealthEvent({ name: "provider.verification_pending", shopId, subjectId: shopId, payload: { kind: "EQUIPMENT_STORE" } });
    return u;
  }
  const [row] = await db.insert(healthEquipmentStoreProfiles).values({ shopId, ...values, createdAt: now }).returning();
  await publishHealthEvent({ name: "provider.verification_pending", shopId, subjectId: shopId, payload: { kind: "EQUIPMENT_STORE" } });
  return row;
}

async function ensureStoreProfile(shopId: string): Promise<HealthEquipmentStoreProfile> {
  await db.insert(healthEquipmentStoreProfiles).values({ shopId }).onConflictDoNothing();
  const [p] = await db.select().from(healthEquipmentStoreProfiles).where(eq(healthEquipmentStoreProfiles.shopId, shopId));
  return p;
}

export interface PendingEquipmentStore {
  shopId: string;
  shopName: string;
  shopType: string;
  city: string;
  ownerId: string;
  verification: string;
  verificationNote: string | null;
  deliveryRadiusKm: number;
  listings: number;
  createdAt: Date;
}

/** Equipment stores waiting for GoKesari's verification (Admin → Health). */
export async function pendingEquipmentStores(): Promise<PendingEquipmentStore[]> {
  const rows = await db
    .select({ p: healthEquipmentStoreProfiles, name: shops.name, shopType: shops.shopType, city: shops.city, ownerId: shops.ownerId, listings: sql<number>`(select count(*)::int from health.equipment_listings l where l.shop_id = ${shops.id})` })
    .from(healthEquipmentStoreProfiles)
    .innerJoin(shops, eq(shops.id, healthEquipmentStoreProfiles.shopId))
    .where(and(eq(healthEquipmentStoreProfiles.verification, "PENDING"), isNull(shops.deletedAt)))
    .orderBy(asc(healthEquipmentStoreProfiles.createdAt))
    .limit(500);
  return rows.map((r) => ({ shopId: r.p.shopId, shopName: r.name, shopType: r.shopType, city: r.city, ownerId: r.ownerId, verification: r.p.verification, verificationNote: r.p.verificationNote, deliveryRadiusKm: r.p.deliveryRadiusKm, listings: Number(r.listings), createdAt: r.p.createdAt }));
}

/** Staff verify (or reject, with a note) an equipment store. The owner is told. */
export async function verifyEquipmentStore(shopId: string, decision: "VERIFIED" | "REJECTED" | "PENDING", note: string | null, actor: HealthActor): Promise<HealthEquipmentStoreProfile> {
  if (!isHealthStaff(actor)) throw forbidden("Only GoKesari Health staff can verify equipment stores.");
  if (!["VERIFIED", "REJECTED", "PENDING"].includes(decision)) throw validationFailed("Unknown decision.");
  if (decision === "REJECTED" && !note?.trim()) throw validationFailed("Give the store a reason.", { fields: { note: "Required." } });
  const [s] = await db.select({ ownerId: shops.ownerId, name: shops.name }).from(shops).where(eq(shops.id, shopId));
  if (!s) throw notFound("Store");
  const before = await ensureStoreProfile(shopId);
  const now = new Date();
  const row = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(healthEquipmentStoreProfiles)
      .set({ verification: decision, verificationNote: note?.trim().slice(0, 500) || null, verifiedBy: actor.id, verifiedAt: now, updatedAt: now })
      .where(eq(healthEquipmentStoreProfiles.shopId, shopId))
      .returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_EQUIPMENT_STORE, entityType: "health_equipment_store", entityId: shopId, previousValue: { verification: before.verification }, newValue: { verification: decision, note } }, tx);
    const name: HealthEventName = decision === "VERIFIED" ? "provider.verified" : decision === "REJECTED" ? "provider.rejected" : "provider.verification_pending";
    await publishHealthEvent({ name, shopId, userIds: [s.ownerId], subjectId: shopId, payload: { kind: "EQUIPMENT_STORE", verification: decision } }, tx);
    return u;
  });
  await notify({
    userId: s.ownerId,
    type: NOTIFICATION_TYPES.HEALTH_VERIFICATION,
    title: decision === "VERIFIED" ? "Your equipment store is verified" : decision === "REJECTED" ? "Your equipment store needs changes" : "Equipment store verification",
    body: decision === "VERIFIED" ? `${s.name} now shows in GoKesari Health → Medical equipment, and patients can rent from you.` : decision === "REJECTED" ? `${note?.trim()} Update your rental terms in Health → Equipment → Store profile.` : "GoKesari will check your store again.",
    actionUrl: "/shop/health/equipment/profile",
    channels: ["PUSH"],
    metadata: { shopId, verification: decision },
  });
  return row;
}

/* ------------------------------------------------------------ listings */

const money = z.number().min(0).max(10_000_000);

export const listingInput = z
  .object({
    id: z.string().uuid().optional(),
    masterId: z.string().uuid().nullish(),
    name: z.string().trim().max(160).nullish(),
    description: z.string().trim().max(2000).nullish(),
    photoUrl: z.string().trim().url().max(500).nullish().or(z.literal("")),
    forSale: z.boolean().default(false),
    salePriceRupees: money.nullish(),
    shopProductId: z.string().uuid().nullish(),
    forRent: z.boolean().default(true),
    rentDayRupees: money.nullish(),
    rentWeekRupees: money.nullish(),
    rentMonthRupees: money.nullish(),
    minRentDays: z.number().int().min(1).max(365).default(1),
    depositRupees: money.default(0),
    deliveryRupees: money.default(0),
    stock: z.number().int().min(0).max(10_000).default(1),
    rxRequired: z.boolean().nullish(),
    status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  })
  .superRefine((v, ctx) => {
    if (!v.forRent && !v.forSale) ctx.addIssue({ code: "custom", path: ["forRent"], message: "Offer the item for rent, for sale, or both." });
    if (v.forRent && !(v.rentDayRupees || v.rentWeekRupees || v.rentMonthRupees)) ctx.addIssue({ code: "custom", path: ["rentDayRupees"], message: "Enter the rent per day, week or month." });
    if (v.forSale && !v.salePriceRupees && !v.shopProductId) ctx.addIssue({ code: "custom", path: ["salePriceRupees"], message: "Enter the sale price, or link the product from your shop." });
  });
export type ListingInput = z.input<typeof listingInput>;

const paise = (r: number | null | undefined) => (r == null ? null : Math.round(r * 100));

export async function equipmentMaster(): Promise<HealthEquipmentMaster[]> {
  return db.select().from(healthEquipmentMaster).where(eq(healthEquipmentMaster.status, "ACTIVE")).orderBy(asc(healthEquipmentMaster.sortOrder), asc(healthEquipmentMaster.name));
}

/** Adds or changes a listing (from the master list, or custom). */
export async function saveListing(shopId: string, raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<HealthEquipmentListing> {
  await requireHealthEnabled();
  const input = listingInput.parse(raw);
  await requireStoreAccess(shopId, actor);
  await ensureStoreProfile(shopId);
  const [master] = input.masterId ? await db.select().from(healthEquipmentMaster).where(eq(healthEquipmentMaster.id, input.masterId)) : [];
  if (input.masterId && !master) throw validationFailed("Choose the item from the list.", { fields: { masterId: "Unknown item." } });
  const name = input.name?.trim() || master?.name;
  if (!name || name.length < 2) throw validationFailed("Enter the item name.", { fields: { name: "Required." } });
  if (input.shopProductId) {
    const [sp] = await db.select({ shopId: shopProducts.shopId }).from(shopProducts).where(eq(shopProducts.id, input.shopProductId));
    if (!sp || sp.shopId !== shopId) throw validationFailed("Link a product from your own shop.", { fields: { shopProductId: "Not in this shop." } });
  }
  const values = {
    masterId: master?.id ?? null,
    name,
    description: input.description || master?.description || null,
    photoUrl: input.photoUrl || null,
    forSale: input.forSale,
    salePricePaise: input.forSale ? paise(input.salePriceRupees) : null,
    shopProductId: input.forSale ? (input.shopProductId ?? null) : null,
    forRent: input.forRent,
    rentDayPaise: input.forRent ? paise(input.rentDayRupees) || null : null,
    rentWeekPaise: input.forRent ? paise(input.rentWeekRupees) || null : null,
    rentMonthPaise: input.forRent ? paise(input.rentMonthRupees) || null : null,
    minRentDays: input.minRentDays,
    depositPaise: paise(input.depositRupees) ?? 0,
    deliveryPaise: paise(input.deliveryRupees) ?? 0,
    stock: input.stock,
    rxRequired: input.rxRequired ?? master?.rxRequired ?? false,
    status: input.status,
    updatedAt: now,
  };
  if (input.id) {
    const [u] = await db
      .update(healthEquipmentListings)
      .set(values)
      .where(and(eq(healthEquipmentListings.id, input.id), eq(healthEquipmentListings.shopId, shopId)))
      .returning();
    if (!u) throw notFound("Listing");
    return u;
  }
  const [row] = await db.insert(healthEquipmentListings).values({ ...values, shopId, createdAt: now }).returning();
  return row;
}

/* ------------------------------------------------------------ browse */

export const browseInput = z.object({
  q: z.string().trim().max(80).optional(),
  category: z.string().trim().max(60).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(1).max(100).optional(),
  rent: z.enum(["1", "0"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(60),
});

export interface EquipmentCard {
  listingId: string;
  name: string;
  description: string | null;
  photoUrl: string | null;
  category: string | null;
  forRent: boolean;
  rentDayPaise: number | null;
  rentWeekPaise: number | null;
  rentMonthPaise: number | null;
  minRentDays: number;
  depositPaise: number;
  deliveryPaise: number;
  stock: number;
  rxRequired: boolean;
  forSale: boolean;
  salePricePaise: number | null;
  buyUrl: string | null;
  store: { shopId: string; name: string; area: string; distanceKm: number | null; distanceText: string | null; deliveryRadiusKm: number };
}

/** Listings of nearby verified equipment stores (nearest first when a location is given). */
export async function browseEquipment(raw: unknown): Promise<{ results: EquipmentCard[]; categories: string[] }> {
  const input = browseInput.parse(raw);
  const origin = input.lat != null && input.lng != null ? { lat: input.lat, lng: input.lng } : null;
  const lat = sql`CASE WHEN ${shops.latitude} ~ ${"^\\s*-?[0-9]{1,3}(\\.[0-9]+)?\\s*$"} THEN trim(${shops.latitude})::double precision END`;
  const lng = sql`CASE WHEN ${shops.longitude} ~ ${"^\\s*-?[0-9]{1,3}(\\.[0-9]+)?\\s*$"} THEN trim(${shops.longitude})::double precision END`;
  const distance = origin
    ? sql<number | null>`(6371 * 2 * asin(sqrt(power(sin(radians((${lat} - ${origin.lat}) / 2)), 2) + cos(radians(${origin.lat})) * cos(radians(${lat})) * power(sin(radians((${lng} - ${origin.lng}) / 2)), 2))))`
    : sql<number | null>`NULL::double precision`;
  const where = [
    eq(healthEquipmentListings.status, "ACTIVE"),
    eq(healthEquipmentStoreProfiles.verification, "VERIFIED"),
    eq(shops.status, "APPROVED"),
    isNull(shops.deletedAt),
    input.rent === "1" ? sql`${healthEquipmentListings.forRent} AND ${healthEquipmentListings.stock} > 0` : sql`(${healthEquipmentListings.forRent} OR ${healthEquipmentListings.forSale})`,
  ];
  if (input.q) {
    const likeQ = `%${input.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(sql`(${healthEquipmentListings.name} ILIKE ${likeQ} OR ${healthEquipmentListings.description} ILIKE ${likeQ} OR ${healthEquipmentMaster.name} ILIKE ${likeQ})`);
  }
  if (input.category) where.push(eq(healthEquipmentMaster.category, input.category));
  if (origin) where.push(sql`(${distance} IS NULL OR ${distance} <= least(${healthEquipmentStoreProfiles.deliveryRadiusKm}, ${input.radiusKm ?? 100}))`);
  const rows = await db
    .select({ l: healthEquipmentListings, category: healthEquipmentMaster.category, shopName: shops.name, area: shops.area, city: shops.city, radius: healthEquipmentStoreProfiles.deliveryRadiusKm, distanceKm: distance, productId: shopProducts.productId })
    .from(healthEquipmentListings)
    .innerJoin(shops, eq(shops.id, healthEquipmentListings.shopId))
    .innerJoin(healthEquipmentStoreProfiles, eq(healthEquipmentStoreProfiles.shopId, healthEquipmentListings.shopId))
    .leftJoin(healthEquipmentMaster, eq(healthEquipmentMaster.id, healthEquipmentListings.masterId))
    .leftJoin(shopProducts, eq(shopProducts.id, healthEquipmentListings.shopProductId))
    .where(and(...where))
    .orderBy(origin ? sql`${distance} ASC NULLS LAST` : asc(healthEquipmentListings.name), asc(healthEquipmentListings.name))
    .limit(input.limit);
  const cats = await db.selectDistinct({ category: healthEquipmentMaster.category }).from(healthEquipmentMaster).where(eq(healthEquipmentMaster.status, "ACTIVE"));
  return {
    categories: cats.map((c) => c.category).sort(),
    results: rows.map((r) => ({
      listingId: r.l.id,
      name: r.l.name,
      description: r.l.description,
      photoUrl: r.l.photoUrl,
      category: r.category,
      forRent: r.l.forRent,
      rentDayPaise: r.l.rentDayPaise,
      rentWeekPaise: r.l.rentWeekPaise,
      rentMonthPaise: r.l.rentMonthPaise,
      minRentDays: r.l.minRentDays,
      depositPaise: r.l.depositPaise,
      deliveryPaise: r.l.deliveryPaise,
      stock: r.l.stock,
      rxRequired: r.l.rxRequired,
      forSale: r.l.forSale,
      salePricePaise: r.l.salePricePaise,
      buyUrl: r.l.forSale && r.productId ? `/products/${r.productId}` : null,
      store: { shopId: r.l.shopId, name: r.shopName, area: [r.area, r.city].filter(Boolean).join(", "), distanceKm: r.distanceKm == null ? null : Math.round(Number(r.distanceKm) * 10) / 10, distanceText: r.distanceKm == null ? null : formatDistance(Number(r.distanceKm)), deliveryRadiusKm: r.radius },
    })),
  };
}

export interface ListingDetail extends EquipmentCard {
  store: EquipmentCard["store"] & { rentalTerms: string | null; damagePolicy: string | null; phone: string | null; latitude: number | null; longitude: number | null };
  bookable: boolean;
}

/** One listing for the rent form (public). */
export async function listingDetail(listingId: string): Promise<ListingDetail> {
  if (!/^[0-9a-f-]{36}$/i.test(listingId)) throw notFound("Item");
  const [r] = await db
    .select({ l: healthEquipmentListings, category: healthEquipmentMaster.category, shop: shops, p: healthEquipmentStoreProfiles, productId: shopProducts.productId })
    .from(healthEquipmentListings)
    .innerJoin(shops, eq(shops.id, healthEquipmentListings.shopId))
    .leftJoin(healthEquipmentStoreProfiles, eq(healthEquipmentStoreProfiles.shopId, healthEquipmentListings.shopId))
    .leftJoin(healthEquipmentMaster, eq(healthEquipmentMaster.id, healthEquipmentListings.masterId))
    .leftJoin(shopProducts, eq(shopProducts.id, healthEquipmentListings.shopProductId))
    .where(eq(healthEquipmentListings.id, listingId));
  if (!r || r.shop.deletedAt || r.l.status !== "ACTIVE" || r.p?.verification !== "VERIFIED") throw notFound("Item");
  return {
    listingId: r.l.id,
    name: r.l.name,
    description: r.l.description,
    photoUrl: r.l.photoUrl,
    category: r.category,
    forRent: r.l.forRent,
    rentDayPaise: r.l.rentDayPaise,
    rentWeekPaise: r.l.rentWeekPaise,
    rentMonthPaise: r.l.rentMonthPaise,
    minRentDays: r.l.minRentDays,
    depositPaise: r.l.depositPaise,
    deliveryPaise: r.l.deliveryPaise,
    stock: r.l.stock,
    rxRequired: r.l.rxRequired,
    forSale: r.l.forSale,
    salePricePaise: r.l.salePricePaise,
    buyUrl: r.l.forSale && r.productId ? `/products/${r.productId}` : null,
    store: {
      shopId: r.shop.id,
      name: r.shop.name,
      area: [r.shop.area, r.shop.city].filter(Boolean).join(", "),
      distanceKm: null,
      distanceText: null,
      deliveryRadiusKm: r.p.deliveryRadiusKm,
      rentalTerms: r.p.rentalTerms,
      damagePolicy: r.p.damagePolicy,
      phone: r.shop.contactPhone ?? r.shop.phone,
      latitude: coord(r.shop.latitude),
      longitude: coord(r.shop.longitude),
    },
    bookable: r.l.forRent && r.l.stock > 0 && r.shop.status === "APPROVED",
  };
}

/* ------------------------------------------------------------ renting */

export const rentalInput = z.object({
  listingId: z.string().uuid(),
  periodUnit: z.enum(RENTAL_UNITS),
  periodCount: z.number().int().min(1).max(365),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the start date."),
  quantity: z.number().int().min(1).max(50).default(1),
  addressId: z.string().uuid({ message: "Choose a delivery address." }),
  addressNote: z.string().trim().max(300).nullish(),
  patientId: z.string().uuid().nullish(),
  suggestionId: z.string().uuid().nullish(),
  prescriptionId: z.string().uuid().nullish(),
  acceptTerms: z.literal(true, { message: "Please accept the store's rental terms and damage policy." }),
});
export type RentalInput = z.input<typeof rentalInput>;

export interface RentalQuote {
  unitPricePaise: number;
  rentPaise: number;
  depositPaise: number;
  deliveryPaise: number;
  totalPaise: number;
  days: number;
  dueDate: string;
}

/** The money for a rental, worked out from the listing (never from what the browser sent). */
export function quoteRental(listing: HealthEquipmentListing, unit: RentalUnit, count: number, quantity: number, startDate: string): RentalQuote {
  const price = unitPrice(listing, unit);
  if (!price) throw validationFailed(`This item is not rented per ${UNIT_LABEL[unit][0]}.`, { fields: { periodUnit: "Not offered." } });
  const days = count * UNIT_DAYS[unit];
  if (days < listing.minRentDays) throw validationFailed(`The minimum rental is ${listing.minRentDays} day${listing.minRentDays === 1 ? "" : "s"}.`, { fields: { periodCount: "Too short." } });
  const rent = price * count * quantity;
  const deposit = listing.depositPaise * quantity;
  return { unitPricePaise: price, rentPaise: rent, depositPaise: deposit, deliveryPaise: listing.deliveryPaise, totalPaise: rent + deposit + listing.deliveryPaise, days, dueDate: addDays(startDate, days) };
}

async function startRentalPayment(r: HealthRental, actor: HealthActor, key: string, amountPaise: number, description: string): Promise<{ intentId: string; checkoutUrl: string | null }> {
  const { createPaymentIntent } = await import("@/server/payments/intents");
  const [u] = await db.select({ name: users.name, email: users.email, phone: users.phone }).from(users).where(eq(users.id, r.customerId));
  const created = await createPaymentIntent({
    purpose: "HEALTH_RENTAL",
    referenceId: r.id,
    userId: r.customerId,
    amountPaise,
    customer: { id: r.customerId, name: u?.name ?? actor.name ?? null, email: u?.email ?? null, phone: u?.phone ?? null },
    description,
    idempotencyKey: key,
    mode: "CHECKOUT",
    returnPath: `${RENTAL_PATH}/${r.id}`,
  });
  const checkoutUrl = created.checkout ? (created.checkout.kind === "HOSTED_URL" ? created.checkout.url : (created.checkout.url ?? null)) : created.linkUrl;
  return { intentId: created.intent.id, checkoutUrl };
}

async function intentCount(rentalId: string): Promise<number> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(paymentIntents).where(and(eq(paymentIntents.purpose, "HEALTH_RENTAL"), eq(paymentIntents.referenceId, rentalId)));
  return n;
}

/** Books a rental (PENDING_PAYMENT) and starts the online payment. Prescription-only equipment needs a prescription or suggestion. */
export async function createRental(raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<{ rental: HealthRental; checkoutUrl: string | null; intentId: string }> {
  await requireHealthEnabled();
  const input = rentalInput.parse(raw);
  const [row] = await db
    .select({ l: healthEquipmentListings, shop: shops, p: healthEquipmentStoreProfiles })
    .from(healthEquipmentListings)
    .innerJoin(shops, eq(shops.id, healthEquipmentListings.shopId))
    .leftJoin(healthEquipmentStoreProfiles, eq(healthEquipmentStoreProfiles.shopId, healthEquipmentListings.shopId))
    .where(eq(healthEquipmentListings.id, input.listingId));
  if (!row || row.shop.deletedAt || row.l.status !== "ACTIVE") throw notFound("Item");
  if (!row.l.forRent) throw validationFailed("This item is for sale only.");
  if (row.p?.verification !== "VERIFIED" || row.shop.status !== "APPROVED") throw conflict("This store is not taking rentals right now.");
  const today = istDateKey(now);
  if (input.startDate < today) throw validationFailed("The start date cannot be in the past.", { fields: { startDate: "In the past." } });
  if (input.startDate > addDays(today, 60)) throw validationFailed("Choose a start date within the next 60 days.", { fields: { startDate: "Too far ahead." } });
  if (input.quantity > row.l.stock) throw conflict(row.l.stock ? `Only ${row.l.stock} available.` : "Out of stock right now.", { reason: "OUT_OF_STOCK" });
  const quote = quoteRental(row.l, input.periodUnit, input.periodCount, input.quantity, input.startDate);
  const [addr] = await db.select().from(addresses).where(and(eq(addresses.id, input.addressId), eq(addresses.userId, actor.id)));
  if (!addr) throw notFound("Address");
  const from = { lat: coord(row.shop.latitude), lng: coord(row.shop.longitude) };
  const to = { lat: coord(addr.latitude), lng: coord(addr.longitude) };
  if (from.lat != null && from.lng != null && to.lat != null && to.lng != null) {
    const km = haversineKm({ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng });
    if (km > (row.p.deliveryRadiusKm ?? 10)) throw validationFailed(`This store delivers within ${row.p.deliveryRadiusKm} km; your address is ${formatDistance(km)} away.`, { fields: { addressId: "Too far." } });
  }
  // The family member, the doctor's suggestion or prescription (all must be the actor's own patients).
  let patientId = input.patientId ?? null;
  if (patientId) await requirePatientAccess(patientId, actor);
  let suggestionId: string | null = null;
  let prescriptionId: string | null = input.prescriptionId ?? null;
  if (input.suggestionId) {
    const [s] = await db.select().from(healthSuggestions).where(eq(healthSuggestions.id, input.suggestionId));
    if (!s || s.type !== "EQUIPMENT") throw validationFailed("That is not an equipment suggestion.", { fields: { suggestionId: "Not equipment." } });
    await requirePatientAccess(s.patientId, actor);
    if (s.status !== "OPEN") throw conflict("This suggestion was already booked or closed.");
    if (patientId && patientId !== s.patientId) throw validationFailed("The suggestion is for another family member.", { fields: { patientId: "Does not match." } });
    patientId = s.patientId;
    suggestionId = s.id;
    prescriptionId = prescriptionId ?? s.prescriptionId ?? null;
  }
  if (prescriptionId) {
    const [rx] = await db.select({ id: healthPrescriptions.id, patientId: healthPrescriptions.patientId, status: healthPrescriptions.status }).from(healthPrescriptions).where(eq(healthPrescriptions.id, prescriptionId));
    if (!rx) throw notFound("Prescription");
    await requirePatientAccess(rx.patientId, actor);
    if (rx.status !== "ISSUED") throw conflict("This prescription was replaced or cancelled. Choose the current one.");
    if (patientId && patientId !== rx.patientId) throw validationFailed("The prescription is for another family member.", { fields: { prescriptionId: "Does not match." } });
    patientId = rx.patientId;
  }
  if (row.l.rxRequired && !suggestionId && !prescriptionId) {
    throw validationFailed("This equipment needs a doctor's prescription. Choose the prescription or the doctor's suggestion from your health record.", { fields: { prescriptionId: "Required." }, reason: "RX_REQUIRED" });
  }
  const rule = await getRule("health");
  const address = {
    addressId: addr.id,
    label: addr.label,
    text: [addr.line1, addr.line2, addr.landmark, addr.area, addr.city, addr.pincode].filter(Boolean).join(", "),
    pincode: addr.pincode,
    recipientName: addr.recipientName,
    recipientPhone: addr.recipientPhone,
    latitude: to.lat,
    longitude: to.lng,
    note: input.addressNote ?? null,
  };
  const rental = await db.transaction(async (tx) => {
    const year = today.slice(0, 4);
    const n = await nextNumber(tx, `RENT-${year}`);
    const [r] = await tx
      .insert(healthRentals)
      .values({
        rentalNumber: `RENT-${year}-${String(n).padStart(6, "0")}`,
        listingId: row.l.id,
        shopId: row.l.shopId,
        customerId: actor.id,
        patientId,
        suggestionId,
        prescriptionId,
        itemName: row.l.name,
        quantity: input.quantity,
        periodUnit: input.periodUnit,
        periodCount: input.periodCount,
        startDate: input.startDate,
        dueDate: quote.dueDate,
        rentPaise: quote.rentPaise,
        depositPaise: quote.depositPaise,
        deliveryPaise: quote.deliveryPaise,
        totalPaise: quote.totalPaise,
        status: "PENDING_PAYMENT",
        address,
        otpSalt: randomBytes(8).toString("hex"),
        commissionBp: rule.rentalCommissionBp,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (suggestionId) await tx.update(healthSuggestions).set({ status: "BOOKED", linkedRentalId: r.id, bookedAt: now }).where(eq(healthSuggestions.id, suggestionId));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_RENTAL, entityType: "health_rental", entityId: r.id, newValue: { number: r.rentalNumber, status: r.status, totalPaise: r.totalPaise, listingId: r.listingId } }, tx);
    return r;
  });
  try {
    const started = await startRentalPayment(rental, actor, `healthrent:${rental.id}:pay:0`, rental.totalPaise, `GoKesari equipment rental ${rental.rentalNumber}`);
    const [u] = await db.update(healthRentals).set({ paymentIntentId: started.intentId, updatedAt: new Date() }).where(eq(healthRentals.id, rental.id)).returning();
    if (suggestionId) {
      const [p] = await db.select().from(healthPatients).where(eq(healthPatients.id, patientId!));
      if (p) await publishHealthEvent({ name: "suggestion.booked", userIds: patientAudience(p), subjectId: suggestionId, payload: { suggestionId, rentalId: rental.id } });
    }
    return { rental: u, checkoutUrl: started.checkoutUrl, intentId: started.intentId };
  } catch (error) {
    await db.update(healthRentals).set({ status: "CANCELLED", cancelledAt: new Date(), updatedAt: new Date() }).where(eq(healthRentals.id, rental.id));
    if (suggestionId) await reopenSuggestion(db, rental.id);
    throw error;
  }
}

/** A suggestion booked by a rental that never happened goes back to OPEN. */
async function reopenSuggestion(client: DbClient, rentalId: string): Promise<void> {
  await client.update(healthSuggestions).set({ status: "OPEN", linkedRentalId: null, bookedAt: null }).where(and(eq(healthSuggestions.linkedRentalId, rentalId), eq(healthSuggestions.status, "BOOKED")));
}

/** The customer retries the payment of a rental waiting for it. */
export async function payRental(rentalId: string, actor: HealthActor): Promise<{ checkoutUrl: string | null; intentId: string }> {
  await requireHealthEnabled();
  const r = await loadRental(rentalId);
  if (r.customerId !== actor.id) throw notFound("Rental");
  if (r.status !== "PENDING_PAYMENT") throw conflict("This rental has no payment due.");
  if (r.paymentIntentId) {
    const [current] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, r.paymentIntentId));
    const { isLive, redirectUrlOf } = await import("@/server/payments/intents");
    if (current && isLive(current) && current.amountPaise === r.totalPaise) return { checkoutUrl: redirectUrlOf(current), intentId: current.id };
  }
  const started = await startRentalPayment(r, actor, `healthrent:${r.id}:pay:${await intentCount(r.id)}`, r.totalPaise, `GoKesari equipment rental ${r.rentalNumber}`);
  await db.update(healthRentals).set({ paymentIntentId: started.intentId, updatedAt: new Date() }).where(eq(healthRentals.id, r.id));
  return started;
}

/* ------------------------------------------------------------ payment handlers */

const EXT_KEY = /^healthrent:[0-9a-f-]{36}:ext:\d+:(\d+)$/;

/** Purpose handler (purpose-handlers.ts), inside the capture transaction. */
export async function onRentalPaymentCaptured(intent: PaymentIntentRef, client: DbClient, afterCommit?: AfterCommit): Promise<void> {
  const [r] = await client.select().from(healthRentals).where(eq(healthRentals.id, intent.referenceId)).for("update");
  if (!r) return;
  const [row] = await client.select({ key: paymentIntents.idempotencyKey }).from(paymentIntents).where(eq(paymentIntents.id, intent.id));
  const now = new Date();
  const refundIds: string[] = [];
  const ext = row?.key.match(EXT_KEY);
  if (ext) {
    if (r.extensions.some((e) => e.paymentIntentId === intent.id)) return;
    const count = Number(ext[1]);
    if ((r.status === "ACTIVE" || r.status === "RETURN_SCHEDULED") && r.periodCount + count <= 365) {
      const newDueDate = addDays(r.dueDate, count * UNIT_DAYS[r.periodUnit as RentalUnit]);
      const entry: RentalExtension = { at: now.toISOString(), periodCount: count, rentPaise: intent.amountPaise, newDueDate, paymentIntentId: intent.id };
      const [u] = await client
        .update(healthRentals)
        .set({ extensions: [...r.extensions, entry], rentPaise: r.rentPaise + intent.amountPaise, totalPaise: r.totalPaise + intent.amountPaise, paidPaise: r.paidPaise + intent.amountPaise, periodCount: r.periodCount + count, dueDate: newDueDate, updatedAt: now })
        .where(eq(healthRentals.id, r.id))
        .returning();
      if (u.status === "ACTIVE") await scheduleDueReminder(client, u, now);
      await settleRental(client, u, now);
      await recordAudit({ action: AUDIT_ACTIONS.HEALTH_RENTAL, entityType: "health_rental", entityId: r.id, newValue: { extended: count, intentId: intent.id, newDueDate } }, client);
      await rentalEvent("rental.extended", u, client, { periods: count, dueDate: newDueDate });
      await tellRental(u, "BOTH", "Rental extended", `${u.itemName} (${u.rentalNumber}) is now due back on ${formatDateKey(newDueDate)}.`, client);
    } else {
      // Paid after the rental ended (or beyond the longest period): the whole extension is refunded.
      const [u] = await client.update(healthRentals).set({ paidPaise: r.paidPaise + intent.amountPaise, updatedAt: now }).where(eq(healthRentals.id, r.id)).returning();
      refundIds.push(...(await refundIntent(client, intent.id, intent.amountPaise, `${r.rentalNumber}: extension paid after the rental ended`, `ext-late:${intent.id}`)));
      await tellRental(u, "CUSTOMER", "Extension refunded", `The extension payment for ${u.rentalNumber} arrived after the rental ended, so it is being refunded in full.`, client);
    }
  } else if (r.status === "PENDING_PAYMENT" || (r.status === "CANCELLED" && !r.paidPaise)) {
    // An older attempt paid after a retry started is used as the rental's payment; a second capture is refunded below.
    if (intent.amountPaise !== r.totalPaise) {
      await recordAudit({ action: AUDIT_ACTIONS.HEALTH_RENTAL, entityType: "health_rental", entityId: r.id, newValue: { problem: "amount_mismatch", intentId: intent.id, intentAmount: intent.amountPaise, expected: r.totalPaise } }, client);
    }
    const [listing] = await client.select().from(healthEquipmentListings).where(eq(healthEquipmentListings.id, r.listingId)).for("update");
    if (r.status === "PENDING_PAYMENT" && listing && listing.stock >= r.quantity) {
      await client.update(healthEquipmentListings).set({ stock: listing.stock - r.quantity, updatedAt: now }).where(eq(healthEquipmentListings.id, listing.id));
      const [u] = await client.update(healthRentals).set({ status: "CONFIRMED", paidPaise: intent.amountPaise, paymentIntentId: intent.id, updatedAt: now }).where(eq(healthRentals.id, r.id)).returning();
      await recordAudit({ action: AUDIT_ACTIONS.HEALTH_RENTAL, entityType: "health_rental", entityId: r.id, newValue: { status: "CONFIRMED", intentId: intent.id, amountPaise: intent.amountPaise } }, client);
      await rentalEvent("rental.changed", u, client);
      await tellRental(u, "STORE", "New equipment rental", `${u.itemName} × ${u.quantity} for ${periodText(u.periodUnit, u.periodCount)} from ${formatDateKey(u.startDate)}. Rental ${u.rentalNumber} — deliver it and enter the customer's delivery code.`, client);
      await tellRental(u, "CUSTOMER", "Equipment rental booked", `${u.itemName} (${u.rentalNumber}) is booked from ${formatDateKey(u.startDate)}. Give your delivery code to the store when it arrives.`, client);
    } else {
      // Paid after the rental was cancelled, or the last unit went meanwhile: everything is refunded.
      const [u] = await client
        .update(healthRentals)
        .set({ status: "CANCELLED", cancelledAt: r.cancelledAt ?? now, paidPaise: r.paidPaise + intent.amountPaise, paymentIntentId: intent.id, updatedAt: now })
        .where(eq(healthRentals.id, r.id))
        .returning();
      refundIds.push(...(await refundIntent(client, intent.id, intent.amountPaise, `${r.rentalNumber}: ${r.status === "CANCELLED" ? "paid after the rental was cancelled" : "the item went out of stock"}`, `late:${intent.id}`)));
      await reopenSuggestion(client, r.id);
      await rentalEvent("rental.changed", u, client);
      await tellRental(u, "CUSTOMER", "Rental could not be booked", `${u.itemName} is no longer available, so your payment for ${u.rentalNumber} is being refunded in full.`, client);
    }
  } else if (r.paymentIntentId !== intent.id) {
    // A second payment for an already paid rental (two tabs): refund it.
    refundIds.push(...(await refundIntent(client, intent.id, intent.amountPaise, `${r.rentalNumber}: duplicate payment`, `dup:${intent.id}`)));
    await client.update(healthRentals).set({ paidPaise: r.paidPaise + intent.amountPaise, updatedAt: now }).where(eq(healthRentals.id, r.id));
  }
  if (refundIds.length) {
    const send = () => submitRefunds(refundIds);
    if (afterCommit) afterCommit(send);
  }
}

/** Purpose handler for a failed / expired payment (ended-handlers.ts), inside its transaction. */
export async function onRentalPaymentEnded(intent: PaymentIntentRow, to: "FAILED" | "EXPIRED", client: DbClient): Promise<void> {
  const [r] = await client.select().from(healthRentals).where(eq(healthRentals.id, intent.referenceId)).for("update");
  if (!r) return;
  if (EXT_KEY.test(intent.idempotencyKey)) {
    await rentalEvent("rental.changed", r, client, { extensionPayment: to });
    return;
  }
  if (r.status !== "PENDING_PAYMENT" || (r.paymentIntentId && r.paymentIntentId !== intent.id)) return;
  const now = new Date();
  const [u] = await client.update(healthRentals).set({ status: "CANCELLED", cancelledAt: now, updatedAt: now }).where(eq(healthRentals.id, r.id)).returning();
  await reopenSuggestion(client, r.id);
  await rentalEvent("rental.changed", u, client, { payment: to });
}

async function refundIntent(client: DbClient, intentId: string, amount: number, reason: string, tag: string): Promise<string[]> {
  if (amount <= 0) return [];
  const { refundPaymentIntent } = await import("@/server/payments/intents");
  const [{ committed }] = await client
    .select({ committed: sql<number>`coalesce(sum(${paymentRefunds.amountPaise}), 0)::bigint` })
    .from(paymentRefunds)
    .where(and(eq(paymentRefunds.intentId, intentId), inArray(paymentRefunds.status, ["PENDING", "SUCCESS"])));
  const [intent] = await client.select({ amount: paymentIntents.amountPaise, status: paymentIntents.status }).from(paymentIntents).where(eq(paymentIntents.id, intentId));
  if (!intent || (intent.status !== "CAPTURED" && intent.status !== "PARTIALLY_REFUNDED")) return [];
  const take = Math.min(amount, intent.amount - Number(committed));
  if (take <= 0) return [];
  const ref = await refundPaymentIntent({ intentId, amountPaise: take, reason: reason.slice(0, 480), idempotencyKey: `healthrent:refund:${tag}:${intentId}` }, client);
  return [ref.id];
}

/** Sends recorded refunds to the gateway after the commit (the payments reconciliation job retries failures). */
async function submitRefunds(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const { submitRefund } = await import("@/server/payments/intents");
  for (const id of ids) await submitRefund(id).catch((e) => console.error("[health] rental refund deferred to the job", id, e instanceof Error ? e.message : e));
}

/* ------------------------------------------------------------ settlement */

const EARNING: readonly string[] = ["ACTIVE", "RETURN_SCHEDULED", "RETURNED", "CLOSED"];

/**
 * Brings the store's payout lines up to date (under the rental's lock): + rent and delivery once the
 * equipment is delivered (and each paid extension), + damages kept from the deposit at close; − GoKesari's
 * commission on all of it. The deposit itself is never credited. Repeated calls write only differences.
 */
export async function settleRental(client: DbClient, r: HealthRental, now: Date = new Date()): Promise<HealthRental> {
  const earned = EARNING.includes(r.status) ? r.rentPaise + r.deliveryPaise + (r.status === "CLOSED" ? r.damagePaise : 0) : 0;
  const target = commissionOnFee(earned, r.commissionBp);
  const existing = await client.select({ key: financialAdjustments.idempotencyKey, amount: financialAdjustments.amountPaise }).from(financialAdjustments).where(like(financialAdjustments.idempotencyKey, `healthrent:${r.id}:%`));
  const credits = existing.filter((e) => e.key.includes(":credit:"));
  const commissions = existing.filter((e) => e.key.includes(":commission:"));
  const credited = credits.reduce((n, e) => n + e.amount, 0);
  const commissioned = -commissions.reduce((n, e) => n + e.amount, 0);
  const rows: (typeof financialAdjustments.$inferInsert)[] = [];
  if (earned !== credited) {
    rows.push({ type: "SHOP_ADJUSTMENT", party: "SHOP", shopId: r.shopId, amountPaise: earned - credited, reason: `Equipment rental ${r.rentalNumber}: ${earned - credited >= 0 ? (r.status === "CLOSED" && r.damagePaise > 0 ? "rent, delivery and damages" : "rent and delivery") : "correction"}`, idempotencyKey: `healthrent:${r.id}:credit:${credits.length}` });
  }
  if (target !== commissioned) {
    rows.push({ type: "SHOP_ADJUSTMENT", party: "SHOP", shopId: r.shopId, amountPaise: -(target - commissioned), reason: `GoKesari commission ${(r.commissionBp / 100).toFixed(2)}% on equipment rental ${r.rentalNumber}`, idempotencyKey: `healthrent:${r.id}:commission:${commissions.length}` });
  }
  if (!rows.length) return r;
  await client.insert(financialAdjustments).values(rows).onConflictDoNothing();
  const [u] = await client.update(healthRentals).set({ settledAt: now, updatedAt: now }).where(eq(healthRentals.id, r.id)).returning();
  await recordAudit({ action: AUDIT_ACTIONS.HEALTH_RENTAL, entityType: "health_rental", entityId: r.id, newValue: { settled: earned, commissionPaise: target, rows: rows.map((x) => ({ key: x.idempotencyKey, amountPaise: x.amountPaise })) } }, client);
  return u;
}

/* ------------------------------------------------------------ reminders */

/** Puts (or moves) the "due back soon" reminder: 9 AM IST, rule health.rentalDueReminderDays before the due date. */
export async function scheduleDueReminder(client: DbClient, r: Pick<HealthRental, "id" | "dueDate">, now: Date = new Date()): Promise<void> {
  const rule = await getRule("health");
  const key = `health-rental-due:${r.id}`;
  let dueAt = istAt(addDays(r.dueDate, -rule.rentalDueReminderDays), 9 * 60);
  if (dueAt.getTime() <= now.getTime()) dueAt = new Date(now.getTime() + 60_000);
  await client
    .insert(scheduledNotices)
    .values({ kind: RENTAL_DUE_KIND, key, dueAt, payload: { rentalId: r.id, dueDate: r.dueDate } })
    .onConflictDoUpdate({ target: scheduledNotices.key, set: { dueAt, payload: { rentalId: r.id, dueDate: r.dueDate }, sentAt: null, cancelledAt: null, updatedAt: now } });
}

async function cancelDueReminder(client: DbClient, rentalId: string, now: Date = new Date()): Promise<void> {
  await client.update(scheduledNotices).set({ cancelledAt: now, updatedAt: now }).where(and(eq(scheduledNotices.key, `health-rental-due:${rentalId}`), isNull(scheduledNotices.sentAt), isNull(scheduledNotices.cancelledAt)));
}

/** Sends one due reminder (the scheduled-notices sweep, via health/scheduled.ts). False: nothing to do any more. */
export async function sendRentalDueNotice(notice: ScheduledNotice): Promise<boolean> {
  const rentalId = notice.payload.rentalId;
  if (!rentalId) return false;
  const [r] = await db.select().from(healthRentals).where(eq(healthRentals.id, rentalId));
  if (!r || r.status !== "ACTIVE" || (notice.payload.dueDate && notice.payload.dueDate !== r.dueDate)) return false;
  await notify({
    userId: r.customerId,
    type: NOTIFICATION_TYPES.HEALTH_RENTAL_DUE,
    vars: { item: r.itemName, dueDate: formatDateKey(r.dueDate) },
    actionUrl: `${RENTAL_PATH}/${r.id}`,
    channels: ["PUSH"],
    dedupeKey: `${notice.key}:${r.dueDate}`,
    metadata: { rentalId: r.id },
  });
  await rentalTimeline(db, r, "due", `${r.itemName}: due back ${formatDateKey(r.dueDate)}`, `Rental ${r.rentalNumber} is due back soon. Extend it or schedule the return pickup.`, new Date());
  await rentalEvent("rental.due_soon", r, db, { dueDate: r.dueDate });
  return true;
}

/* ------------------------------------------------------------ helpers: load, tell, events, timeline */

async function loadRental(rentalId: string, client: DbClient = db): Promise<HealthRental> {
  if (!/^[0-9a-f-]{36}$/i.test(rentalId)) throw notFound("Rental");
  const [r] = await client.select().from(healthRentals).where(eq(healthRentals.id, rentalId));
  if (!r) throw notFound("Rental");
  return r;
}

async function lockRental(client: DbClient, rentalId: string): Promise<HealthRental> {
  const [r] = await client.select().from(healthRentals).where(eq(healthRentals.id, rentalId)).for("update");
  if (!r) throw notFound("Rental");
  return r;
}

async function audienceOf(r: HealthRental, client: DbClient): Promise<string[]> {
  const ids = [r.customerId];
  if (r.patientId) {
    const [p] = await client.select().from(healthPatients).where(eq(healthPatients.id, r.patientId));
    if (p) ids.push(...patientAudience(p));
  }
  return [...new Set(ids)];
}

async function rentalEvent(name: HealthEventName, r: HealthRental, client: DbClient = db, extra: Record<string, unknown> = {}): Promise<void> {
  await publishHealthEvent({ name, userIds: await audienceOf(r, client), shopId: r.shopId, subjectId: r.id, payload: { rentalId: r.id, status: r.status, ...extra } }, client);
}

async function tellRental(r: HealthRental, who: "CUSTOMER" | "STORE" | "BOTH", title: string, body: string, client: DbClient = db): Promise<void> {
  if (who !== "STORE") {
    for (const userId of await audienceOf(r, client)) {
      await notify({ userId, type: NOTIFICATION_TYPES.HEALTH_RENTAL, title, body, actionUrl: `${RENTAL_PATH}/${r.id}`, channels: ["PUSH"], metadata: { rentalId: r.id } }, client);
    }
  }
  if (who !== "CUSTOMER") {
    const [s] = await client.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, r.shopId));
    if (s) await notify({ userId: s.ownerId, type: NOTIFICATION_TYPES.HEALTH_RENTAL, title, body, actionUrl: `${STORE_RENTAL_PATH}/${r.id}`, channels: ["PUSH"], metadata: { rentalId: r.id } }, client);
  }
}

async function rentalTimeline(client: DbClient, r: HealthRental, stage: "start" | "due" | "return" | "close", title: string, summary: string, at: Date): Promise<void> {
  if (!r.patientId) return;
  const [s] = await client.select({ name: shops.name }).from(shops).where(eq(shops.id, r.shopId));
  await addTimeline(client, {
    patientId: r.patientId,
    occurredAt: at,
    kind: "EQUIPMENT",
    title,
    summary,
    providerName: s?.name ?? null,
    providerShopId: r.shopId,
    refType: stage === "start" ? "rental" : `rental-${stage}`,
    refId: r.id,
    meta: { rentalNumber: r.rentalNumber, status: r.status, dueDate: r.dueDate },
  });
}

async function storeRental(rentalId: string, actor: HealthActor): Promise<HealthRental> {
  const r = await loadRental(rentalId);
  await requireStoreAccess(r.shopId, actor);
  return r;
}

/* ------------------------------------------------------------ lifecycle: store */

/** The store sends the equipment out. */
export async function dispatchRental(rentalId: string, actor: HealthActor, now: Date = new Date()): Promise<HealthRental> {
  const before = await storeRental(rentalId, actor);
  if (before.status !== "CONFIRMED") throw conflict("Only a booked rental can be sent out.");
  return db.transaction(async (tx) => {
    const r = await lockRental(tx, rentalId);
    if (r.status !== "CONFIRMED") throw conflict("Only a booked rental can be sent out.");
    const [u] = await tx.update(healthRentals).set({ status: "OUT_FOR_DELIVERY", updatedAt: now }).where(eq(healthRentals.id, r.id)).returning();
    await rentalEvent("rental.changed", u, tx);
    await tellRental(u, "CUSTOMER", "Equipment on the way", `${u.itemName} (${u.rentalNumber}) is out for delivery. Give your delivery code from My Health to the delivery person after checking the item.`, tx);
    return u;
  });
}

/** Delivered: the store enters the patient's delivery code → the rental starts (ACTIVE); the due reminder is scheduled. */
export async function deliverRental(rentalId: string, code: string | null, actor: HealthActor, now: Date = new Date()): Promise<HealthRental> {
  const before = await storeRental(rentalId, actor);
  if (before.status !== "CONFIRMED" && before.status !== "OUT_FOR_DELIVERY") throw conflict("This rental is not waiting for delivery.");
  const rule = await getRule("health");
  if (before.otpAttempts >= rule.careOtpMaxAttempts) throw conflict("Too many wrong codes. Ask GoKesari support to help.", { reason: "OTP_LOCKED" });
  if (!deliveryCodeMatches(before.id, before.otpSalt, code)) {
    await db.update(healthRentals).set({ otpAttempts: sql`${healthRentals.otpAttempts} + 1`, updatedAt: now }).where(eq(healthRentals.id, before.id));
    const left = rule.careOtpMaxAttempts - before.otpAttempts - 1;
    throw new AppError("VALIDATION_FAILED", left > 0 ? `That code is not right. ${left} tries left. Ask the customer for the delivery code in My Health.` : "That code is not right. No tries left — ask GoKesari support.", { reason: "OTP_WRONG", left, fields: { code: "Wrong code." } });
  }
  return db.transaction(async (tx) => {
    const r = await lockRental(tx, rentalId);
    if (r.status !== "CONFIRMED" && r.status !== "OUT_FOR_DELIVERY") throw conflict("This rental is not waiting for delivery.");
    // Delivered later than the chosen start: the paid period starts on the delivery day.
    const today = istDateKey(now);
    const shift = today > r.startDate ? Math.round((istAt(today, 0).getTime() - istAt(r.startDate, 0).getTime()) / 86_400_000) : 0;
    const [u] = await tx
      .update(healthRentals)
      .set({ status: "ACTIVE", deliveredAt: now, otpAttempts: 0, ...(shift > 0 ? { startDate: today, dueDate: addDays(r.dueDate, shift) } : {}), updatedAt: now })
      .where(eq(healthRentals.id, r.id))
      .returning();
    await scheduleDueReminder(tx, u, now);
    const settled = await settleRental(tx, u, now);
    await rentalTimeline(tx, settled, "start", `${settled.itemName} rented`, `Rental ${settled.rentalNumber}: ${settled.quantity} × ${settled.itemName} for ${periodText(settled.periodUnit, settled.periodCount)}, due back ${formatDateKey(settled.dueDate)}.`, now);
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_RENTAL, entityType: "health_rental", entityId: r.id, previousValue: { status: r.status }, newValue: { status: "ACTIVE" } }, tx);
    await rentalEvent("rental.started", settled, tx, { dueDate: settled.dueDate });
    await tellRental(settled, "CUSTOMER", "Equipment delivered", `${settled.itemName} (${settled.rentalNumber}) is delivered. It is due back on ${formatDateKey(settled.dueDate)}; we will remind you before that.`, tx);
    return settled;
  });
}

export const scheduleReturnInput = z.object({ pickupAt: z.string().datetime({ offset: true }) });

/** The patient (or the store) schedules the return pickup. */
export async function scheduleReturn(rentalId: string, raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<HealthRental> {
  const input = scheduleReturnInput.parse(raw);
  const before = await loadRental(rentalId);
  const side = before.customerId === actor.id ? "CUSTOMER" : (await requireStoreAccess(before.shopId, actor), "STORE");
  if (before.status !== "ACTIVE" && before.status !== "RETURN_SCHEDULED") throw conflict("The return can be scheduled while the equipment is in use.");
  const at = new Date(input.pickupAt);
  if (at.getTime() < now.getTime() - 5 * 60_000) throw validationFailed("Choose a pickup time in the future.", { fields: { pickupAt: "In the past." } });
  if (at.getTime() > now.getTime() + 120 * 86_400_000) throw validationFailed("Choose a pickup time within the next 120 days.");
  return db.transaction(async (tx) => {
    const r = await lockRental(tx, rentalId);
    if (r.status !== "ACTIVE" && r.status !== "RETURN_SCHEDULED") throw conflict("The return can be scheduled while the equipment is in use.");
    const [u] = await tx.update(healthRentals).set({ status: "RETURN_SCHEDULED", returnPickupAt: at, updatedAt: now }).where(eq(healthRentals.id, r.id)).returning();
    await cancelDueReminder(tx, r.id, now);
    await rentalTimeline(tx, u, "return", `${u.itemName}: return pickup ${formatSlot(at)}`, `Rental ${u.rentalNumber}: the store will collect it.`, now);
    await rentalEvent("rental.return_scheduled", u, tx, { by: side });
    await tellRental(u, side === "CUSTOMER" ? "STORE" : "CUSTOMER", "Return pickup scheduled", `${u.itemName} (${u.rentalNumber}): pickup on ${formatSlot(at)}.`, tx);
    return u;
  });
}

/** The store collected the equipment (condition check next). */
export async function markReturned(rentalId: string, actor: HealthActor, now: Date = new Date()): Promise<HealthRental> {
  const before = await storeRental(rentalId, actor);
  if (before.status !== "ACTIVE" && before.status !== "RETURN_SCHEDULED") throw conflict("This rental is not out with the customer.");
  return db.transaction((tx) => returnedIn(tx, rentalId, actor, now));
}

async function returnedIn(tx: DbClient, rentalId: string, actor: HealthActor, now: Date): Promise<HealthRental> {
  const r = await lockRental(tx, rentalId);
  if (r.status !== "ACTIVE" && r.status !== "RETURN_SCHEDULED") throw conflict("This rental is not out with the customer.");
  const [u] = await tx.update(healthRentals).set({ status: "RETURNED", returnedAt: now, updatedAt: now }).where(eq(healthRentals.id, r.id)).returning();
  await cancelDueReminder(tx, r.id, now);
  await rentalTimeline(tx, u, "return", `${u.itemName} returned`, `Rental ${u.rentalNumber}: collected by the store on ${formatSlot(now)}.`, now);
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_RENTAL, entityType: "health_rental", entityId: r.id, previousValue: { status: r.status }, newValue: { status: "RETURNED" } }, tx);
  await rentalEvent("rental.returned", u, tx);
  return u;
}

export const closeInput = z.object({
  conditionNote: z.string().trim().min(3, "Note the condition of the returned equipment.").max(2000),
  damageRupees: z.number().min(0).max(10_000_000).default(0),
});

/** Condition check: damages (at most the deposit) are kept, the rest of the deposit is refunded, stock comes back, the rental closes. */
export async function closeRental(rentalId: string, raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<HealthRental> {
  const input = closeInput.parse(raw);
  const before = await storeRental(rentalId, actor);
  if (!["ACTIVE", "RETURN_SCHEDULED", "RETURNED"].includes(before.status)) throw conflict("This rental cannot be closed now.");
  const damage = Math.round(input.damageRupees * 100);
  if (damage > before.depositPaise) throw validationFailed(`Damages can be at most the deposit (₹${(before.depositPaise / 100).toFixed(2)}).`, { fields: { damageRupees: "More than the deposit." } });
  const refundIds: string[] = [];
  const closed = await db.transaction(async (tx) => {
    let r = await lockRental(tx, rentalId);
    if (r.status === "ACTIVE" || r.status === "RETURN_SCHEDULED") r = await returnedIn(tx, rentalId, actor, now);
    if (r.status !== "RETURNED") throw conflict("This rental cannot be closed now.");
    const refund = r.depositPaise - damage;
    if (refund > 0 && r.paymentIntentId) refundIds.push(...(await refundIntent(tx, r.paymentIntentId, refund, `${r.rentalNumber}: deposit refund${damage ? " less damages" : ""}`, `deposit:${r.id}`)));
    const [u] = await tx
      .update(healthRentals)
      .set({ status: "CLOSED", conditionNote: input.conditionNote, damagePaise: damage, depositRefundPaise: Math.max(0, refund), depositRefundedAt: refund > 0 ? now : null, closedAt: now, updatedAt: now })
      .where(eq(healthRentals.id, r.id))
      .returning();
    await tx.update(healthEquipmentListings).set({ stock: sql`${healthEquipmentListings.stock} + ${r.quantity}`, updatedAt: now }).where(eq(healthEquipmentListings.id, r.listingId));
    const settled = await settleRental(tx, u, now);
    await rentalTimeline(tx, settled, "close", `${settled.itemName}: rental closed`, `Rental ${settled.rentalNumber} closed. Deposit refund ₹${(settled.depositRefundPaise / 100).toFixed(2)}${damage ? `, damages ₹${(damage / 100).toFixed(2)}` : ""}.`, now);
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_RENTAL, entityType: "health_rental", entityId: r.id, previousValue: { status: r.status }, newValue: { status: "CLOSED", damagePaise: damage, depositRefundPaise: refund, refundIds } }, tx);
    await rentalEvent("rental.deposit_refunded", settled, tx, { depositRefundPaise: settled.depositRefundPaise, damagePaise: damage });
    await tellRental(
      settled,
      "CUSTOMER",
      "Rental closed — deposit refund",
      refund > 0 ? `${settled.itemName} (${settled.rentalNumber}) is checked. ₹${(refund / 100).toFixed(2)} of your deposit is being refunded to your original payment method${damage ? ` (₹${(damage / 100).toFixed(2)} kept for damage: ${input.conditionNote.slice(0, 120)})` : ""}.` : `${settled.itemName} (${settled.rentalNumber}) is checked. The deposit was kept for damage: ${input.conditionNote.slice(0, 160)}.`,
      tx,
    );
    return settled;
  });
  await submitRefunds(refundIds);
  return closed;
}

/** Cancel before delivery (customer or store): every rupee paid is refunded and the stock comes back. */
export async function cancelRental(rentalId: string, reason: string | null, actor: HealthActor, now: Date = new Date()): Promise<HealthRental> {
  const before = await loadRental(rentalId);
  const side = before.customerId === actor.id ? "CUSTOMER" : (await requireStoreAccess(before.shopId, actor), "STORE");
  if (!["PENDING_PAYMENT", "CONFIRMED", "OUT_FOR_DELIVERY"].includes(before.status)) throw conflict("A rental can be cancelled only before delivery.");
  if (side === "STORE" && !reason?.trim()) throw validationFailed("Give the customer a reason.", { fields: { reason: "Required." } });
  const refundIds: string[] = [];
  const out = await db.transaction(async (tx) => {
    const r = await lockRental(tx, rentalId);
    if (!["PENDING_PAYMENT", "CONFIRMED", "OUT_FOR_DELIVERY"].includes(r.status)) throw conflict("A rental can be cancelled only before delivery.");
    if (r.status !== "PENDING_PAYMENT") {
      if (r.paymentIntentId) refundIds.push(...(await refundIntent(tx, r.paymentIntentId, r.paidPaise, `${r.rentalNumber}: cancelled before delivery`, `cancel:${r.id}`)));
      await tx.update(healthEquipmentListings).set({ stock: sql`${healthEquipmentListings.stock} + ${r.quantity}`, updatedAt: now }).where(eq(healthEquipmentListings.id, r.listingId));
    }
    const [u] = await tx.update(healthRentals).set({ status: "CANCELLED", cancelledAt: now, conditionNote: reason?.trim().slice(0, 500) || r.conditionNote, updatedAt: now }).where(eq(healthRentals.id, r.id)).returning();
    await reopenSuggestion(tx, r.id);
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_RENTAL, entityType: "health_rental", entityId: r.id, previousValue: { status: r.status }, newValue: { status: "CANCELLED", by: side, refundIds } }, tx);
    await rentalEvent("rental.changed", u, tx, { by: side });
    await tellRental(u, side === "CUSTOMER" ? "STORE" : "CUSTOMER", "Rental cancelled", `${u.itemName} (${u.rentalNumber}) was cancelled${side === "CUSTOMER" ? " by the customer" : `: ${reason?.trim().slice(0, 200)}`}.${r.paidPaise ? " The payment is refunded in full." : ""}`, tx);
    return u;
  });
  await submitRefunds(refundIds);
  return out;
}

/* ------------------------------------------------------------ lifecycle: patient */

export const extendInput = z.object({ periodCount: z.number().int().min(1).max(365) });

/** Extends a rental in use: another payment for the extra period at the booked rate; the due date moves when it is paid. */
export async function extendRental(rentalId: string, raw: unknown, actor: HealthActor): Promise<{ checkoutUrl: string | null; intentId: string; amountPaise: number; newDueDate: string }> {
  await requireHealthEnabled();
  const input = extendInput.parse(raw);
  const r = await loadRental(rentalId);
  if (r.customerId !== actor.id) throw notFound("Rental");
  if (r.status !== "ACTIVE") throw conflict("Only a rental in use can be extended.");
  if (r.periodCount + input.periodCount > 365) throw validationFailed("A rental can run for at most 365 periods. Start a new rental instead.");
  const rate = bookedRate(r);
  const amount = rate * input.periodCount * r.quantity;
  if (amount <= 0) throw conflict("This rental cannot be extended online. Contact the store.");
  const n = await intentCount(r.id);
  const started = await startRentalPayment(r, actor, `healthrent:${r.id}:ext:${n}:${input.periodCount}`, amount, `GoKesari rental ${r.rentalNumber}: extension of ${periodText(r.periodUnit, input.periodCount)}`);
  return { ...started, amountPaise: amount, newDueDate: addDays(r.dueDate, input.periodCount * UNIT_DAYS[r.periodUnit as RentalUnit]) };
}

/** The rate booked per period per unit (from the first booking, not today's price). */
function bookedRate(r: Pick<HealthRental, "rentPaise" | "periodCount" | "quantity" | "extensions">): number {
  const extRent = r.extensions.reduce((n, e) => n + e.rentPaise, 0);
  const extCount = r.extensions.reduce((n, e) => n + e.periodCount, 0);
  const baseCount = r.periodCount - extCount;
  return baseCount > 0 ? Math.round((r.rentPaise - extRent) / (baseCount * r.quantity)) : 0;
}

export const disputeInput = z.object({ reason: z.string().trim().min(10, "Tell us what went wrong (at least 10 characters).").max(2000) });

/** A complaint about a rental opens a help-desk ticket linked to the store. */
export async function rentalDispute(rentalId: string, raw: unknown, actor: HealthActor): Promise<{ ticketId: string; ticketNumber: string }> {
  const input = disputeInput.parse(raw);
  const r = await loadRental(rentalId);
  if (r.customerId !== actor.id) throw notFound("Rental");
  if (r.status === "PENDING_PAYMENT") throw conflict("Nothing to dispute yet.");
  const { createTicket } = await import("@/server/aftercare/support-tickets");
  const ticket = await createTicket(
    {
      category: "OTHER",
      subject: `Equipment rental ${r.rentalNumber}: ${r.itemName}`.slice(0, 200),
      description: `${input.reason}\n\nRental ${r.rentalNumber}, status ${r.status}. Paid ₹${(r.paidPaise / 100).toFixed(2)} (deposit ₹${(r.depositPaise / 100).toFixed(2)}, damages kept ₹${(r.damagePaise / 100).toFixed(2)}, deposit refund ₹${(r.depositRefundPaise / 100).toFixed(2)}).`,
      priority: "HIGH",
    },
    actor,
  );
  await db.update(supportTickets).set({ shopId: r.shopId }).where(eq(supportTickets.id, ticket.id));
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_RENTAL, entityType: "health_rental", entityId: r.id, newValue: { dispute: ticket.ticketNumber } });
  await tellRental(r, "STORE", "Complaint about a rental", `The customer raised a complaint about ${r.rentalNumber} (ticket ${ticket.ticketNumber}). GoKesari support will contact you.`);
  return { ticketId: ticket.id, ticketNumber: ticket.ticketNumber };
}

/* ------------------------------------------------------------ views */

export interface RentalCard {
  id: string;
  rentalNumber: string;
  itemName: string;
  quantity: number;
  status: string;
  statusLabel: string;
  periodText: string;
  startDate: string;
  dueDate: string;
  totalPaise: number;
  shopName: string;
  patientName: string | null;
  createdAt: Date;
}

function card(r: HealthRental, shopName: string, patientName: string | null): RentalCard {
  return { id: r.id, rentalNumber: r.rentalNumber, itemName: r.itemName, quantity: r.quantity, status: r.status, statusLabel: RENTAL_STATUS_LABELS[r.status as RentalStatus] ?? r.status, periodText: periodText(r.periodUnit, r.periodCount), startDate: r.startDate, dueDate: r.dueDate, totalPaise: r.totalPaise, shopName, patientName, createdAt: r.createdAt };
}

/** The customer's rentals (newest first). */
export async function customerRentals(actor: HealthActor): Promise<RentalCard[]> {
  const rows = await db
    .select({ r: healthRentals, shopName: shops.name, patientName: healthPatients.fullName })
    .from(healthRentals)
    .innerJoin(shops, eq(shops.id, healthRentals.shopId))
    .leftJoin(healthPatients, eq(healthPatients.id, healthRentals.patientId))
    .where(eq(healthRentals.customerId, actor.id))
    .orderBy(desc(healthRentals.createdAt))
    .limit(200);
  return rows.map((x) => card(x.r, x.shopName, x.patientName));
}

export interface RentalRefundRow {
  amountPaise: number;
  status: string;
  createdAt: Date;
  settledAt: Date | null;
}

export interface RentalView {
  viewer: "CUSTOMER" | "STORE";
  rental: Omit<HealthRental, "otpSalt"> & { statusLabel: string; periodText: string };
  store: { shopId: string; name: string; phone: string | null; rentalTerms: string | null; damagePolicy: string | null };
  listing: { photoUrl: string | null; unitPricePaise: number | null };
  customer: { name: string | null; phone: string | null } | null;
  patientName: string | null;
  prescriptionNumber: string | null;
  deliveryCode: string | null;
  refunds: RentalRefundRow[];
  bookedRatePaise: number;
  can: { pay: boolean; cancel: boolean; extend: boolean; scheduleReturn: boolean; dispute: boolean; dispatch: boolean; deliver: boolean; markReturned: boolean; close: boolean };
  otpMaxAttempts: number;
}

/** One rental for the customer (and the family member's linked account), or for the store. */
export async function rentalView(rentalId: string, actor: HealthActor): Promise<RentalView> {
  const r = await loadRental(rentalId);
  let viewer: RentalView["viewer"];
  if (r.customerId === actor.id) viewer = "CUSTOMER";
  else if (r.patientId && (await requirePatientAccess(r.patientId, actor).then(() => true).catch(() => false))) viewer = "CUSTOMER";
  else {
    await requireStoreAccess(r.shopId, actor);
    viewer = "STORE";
  }
  const [s] = await db.select({ name: shops.name, phone: shops.contactPhone, shopPhone: shops.phone, terms: healthEquipmentStoreProfiles.rentalTerms, damage: healthEquipmentStoreProfiles.damagePolicy }).from(shops).leftJoin(healthEquipmentStoreProfiles, eq(healthEquipmentStoreProfiles.shopId, shops.id)).where(eq(shops.id, r.shopId));
  const [l] = await db.select().from(healthEquipmentListings).where(eq(healthEquipmentListings.id, r.listingId));
  const [cu] = viewer === "STORE" ? await db.select({ name: users.name, phone: users.phone }).from(users).where(eq(users.id, r.customerId)) : [];
  const [p] = r.patientId ? await db.select({ name: healthPatients.fullName }).from(healthPatients).where(eq(healthPatients.id, r.patientId)) : [];
  const [rx] = r.prescriptionId ? await db.select({ n: healthPrescriptions.rxNumber }).from(healthPrescriptions).where(eq(healthPrescriptions.id, r.prescriptionId)) : [];
  const intentIds = (await db.select({ id: paymentIntents.id }).from(paymentIntents).where(and(eq(paymentIntents.purpose, "HEALTH_RENTAL"), eq(paymentIntents.referenceId, r.id)))).map((x) => x.id);
  const refunds = intentIds.length ? await db.select({ amountPaise: paymentRefunds.amountPaise, status: paymentRefunds.status, createdAt: paymentRefunds.createdAt, settledAt: paymentRefunds.settledAt }).from(paymentRefunds).where(inArray(paymentRefunds.intentId, intentIds)).orderBy(asc(paymentRefunds.createdAt)) : [];
  const rule = await getRule("health");
  const { otpSalt, ...rest } = r;
  const own = r.customerId === actor.id;
  return {
    viewer,
    rental: { ...rest, statusLabel: RENTAL_STATUS_LABELS[r.status as RentalStatus] ?? r.status, periodText: periodText(r.periodUnit, r.periodCount) },
    store: { shopId: r.shopId, name: s?.name ?? "", phone: s?.phone ?? s?.shopPhone ?? null, rentalTerms: s?.terms ?? null, damagePolicy: s?.damage ?? null },
    listing: { photoUrl: l?.photoUrl ?? null, unitPricePaise: l ? unitPrice(l, r.periodUnit as RentalUnit) : null },
    customer: viewer === "STORE" ? { name: cu?.name ?? null, phone: (r.address as { recipientPhone?: string | null } | null)?.recipientPhone ?? cu?.phone ?? null } : null,
    patientName: p?.name ?? null,
    prescriptionNumber: rx?.n ?? null,
    deliveryCode: viewer === "CUSTOMER" && (r.status === "CONFIRMED" || r.status === "OUT_FOR_DELIVERY") ? deliveryCode(r.id, otpSalt) : null,
    refunds,
    bookedRatePaise: bookedRate(r),
    can: {
      pay: own && r.status === "PENDING_PAYMENT",
      cancel: (viewer === "STORE" || own) && ["PENDING_PAYMENT", "CONFIRMED", "OUT_FOR_DELIVERY"].includes(r.status),
      extend: own && r.status === "ACTIVE",
      scheduleReturn: (own || viewer === "STORE") && (r.status === "ACTIVE" || r.status === "RETURN_SCHEDULED"),
      dispute: own && r.status !== "PENDING_PAYMENT",
      dispatch: viewer === "STORE" && r.status === "CONFIRMED",
      deliver: viewer === "STORE" && (r.status === "CONFIRMED" || r.status === "OUT_FOR_DELIVERY"),
      markReturned: viewer === "STORE" && (r.status === "ACTIVE" || r.status === "RETURN_SCHEDULED"),
      close: viewer === "STORE" && ["ACTIVE", "RETURN_SCHEDULED", "RETURNED"].includes(r.status),
    },
    otpMaxAttempts: rule.careOtpMaxAttempts,
  };
}

export interface StoreBoard {
  shop: { id: string; name: string; shopType: string; status: string };
  profile: HealthEquipmentStoreProfile | null;
  listings: HealthEquipmentListing[];
  rentals: (RentalCard & { customerName: string | null })[];
  counts: Record<string, number>;
  master: HealthEquipmentMaster[];
  shopProducts: { id: string; name: string }[];
}

/** The store's listings and rentals board. */
export async function storeBoard(shopId: string, actor: HealthActor): Promise<StoreBoard> {
  const { shop } = await requireStoreAccess(shopId, actor);
  const [[profile], listings, rentals, master, products] = await Promise.all([
    db.select().from(healthEquipmentStoreProfiles).where(eq(healthEquipmentStoreProfiles.shopId, shopId)),
    db.select().from(healthEquipmentListings).where(eq(healthEquipmentListings.shopId, shopId)).orderBy(asc(healthEquipmentListings.name)),
    db
      .select({ r: healthRentals, customerName: users.name, patientName: healthPatients.fullName })
      .from(healthRentals)
      .innerJoin(users, eq(users.id, healthRentals.customerId))
      .leftJoin(healthPatients, eq(healthPatients.id, healthRentals.patientId))
      .where(eq(healthRentals.shopId, shopId))
      .orderBy(desc(healthRentals.createdAt))
      .limit(300),
    equipmentMaster(),
    db.execute<{ id: string; name: string }>(sql`select sp.id, p.name from shop_products sp join products p on p.id = sp.product_id where sp.shop_id = ${shopId} order by p.name limit 500`).catch(() => [] as { id: string; name: string }[]),
  ]);
  const counts: Record<string, number> = {};
  for (const x of rentals) counts[x.r.status] = (counts[x.r.status] ?? 0) + 1;
  return {
    shop: { id: shop.id, name: shop.name, shopType: shop.shopType, status: shop.status },
    profile: profile ?? null,
    listings,
    rentals: rentals.filter((x) => x.r.status !== "PENDING_PAYMENT").map((x) => ({ ...card(x.r, shop.name, x.patientName), customerName: x.customerName })),
    counts,
    master,
    shopProducts: [...products].map((p) => ({ id: p.id, name: p.name })),
  };
}

/** For the rent form: the actor's family, saved addresses, prescriptions and equipment suggestions (and one preselected). */
export async function rentalContext(actor: HealthActor, suggestionId?: string | null) {
  const { patientsForUser } = await import("./access");
  const patients = await patientsForUser(actor.id);
  const ids = patients.map((p) => p.id);
  const [saved, rxs, sugg] = await Promise.all([
    db.select().from(addresses).where(eq(addresses.userId, actor.id)).orderBy(desc(addresses.isDefault), desc(addresses.createdAt)).limit(20),
    ids.length ? db.select({ id: healthPrescriptions.id, rxNumber: healthPrescriptions.rxNumber, patientId: healthPrescriptions.patientId, issuedAt: healthPrescriptions.issuedAt }).from(healthPrescriptions).where(and(inArray(healthPrescriptions.patientId, ids), eq(healthPrescriptions.status, "ISSUED"))).orderBy(desc(healthPrescriptions.issuedAt)).limit(50) : Promise.resolve([]),
    ids.length ? db.select({ id: healthSuggestions.id, patientId: healthSuggestions.patientId, details: healthSuggestions.details, createdAt: healthSuggestions.createdAt }).from(healthSuggestions).where(and(inArray(healthSuggestions.patientId, ids), eq(healthSuggestions.type, "EQUIPMENT"), eq(healthSuggestions.status, "OPEN"))).orderBy(desc(healthSuggestions.createdAt)).limit(50) : Promise.resolve([]),
  ]);
  const describe = (d: Record<string, unknown>) => String(d.item ?? d.name ?? d.equipment ?? d.text ?? d.note ?? "Equipment").slice(0, 120);
  const pre = suggestionId ? sugg.find((s) => s.id === suggestionId) : undefined;
  return {
    patients: patients.map((p) => ({ id: p.id, name: p.fullName, relation: p.relation })),
    addresses: saved.map((a) => ({ id: a.id, label: a.label, text: [a.line1, a.line2, a.area, a.city, a.pincode].filter(Boolean).join(", ") })),
    prescriptions: rxs.map((x) => ({ id: x.id, rxNumber: x.rxNumber, patientId: x.patientId, issuedAt: x.issuedAt })),
    suggestions: sugg.map((s) => ({ id: s.id, patientId: s.patientId, text: describe(s.details), createdAt: s.createdAt })),
    preselect: pre ? { suggestionId: pre.id, patientId: pre.patientId } : null,
  };
}
