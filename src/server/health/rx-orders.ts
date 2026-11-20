/**
 * GoKesari Health: "Get medicines" — a prescription forwarded to a GoKesari medical store (owner brief
 * §2.5, §4.1). Its own flow, because the core order table cannot hold non-catalogue lines.
 *
 *  1. The patient (account holder or the linked adult) picks medicines from an ISSUED prescription that
 *     is still valid: never more than prescribed minus already dispensed, and only medicines the drug
 *     master allows to be sold online (Schedule X / NDPS / restricted are bought at the counter).
 *  2. Chooses a verified GoKesari medical store (nearest first, open now, rating, the stores they used
 *     before) and PICKUP (preferred time) or DELIVERY (a saved address inside the store's radius).
 *  3. The request goes out as SENT; the store has rule health.storeResponseMinutes (15) to reply, after
 *     which a scheduled notice (HEALTH_RX_EXPIRY) marks it EXPIRED and the patient picks another store.
 *  4. The store sees only this prescription (prescriptionView, viewer STORE — logged), checks the doctor,
 *     the QR, the date and the online-sale rule, and quotes each line (available / partial / unavailable /
 *     substitute of the same generic and strength) or declines with a reason.
 *  5. The patient approves (each substitute separately; a rejected one drops to 0), totals are worked out
 *     here, and pays online (payment intent HEALTH_RX_ORDER → PAID) or at handover when the store allows.
 *  6. The store packs, then READY_FOR_PICKUP or OUT_FOR_DELIVERY (its own delivery person; GoKesari rider
 *     delivery is phase 2). The patient's 4-digit code (HMAC, never stored, 5 tries) completes the order.
 *  7. Completion, in one transaction: the bill (number, batch, expiry, quantity per line), the
 *     prescription's dispensed quantities (guarded: never above the prescribed quantity), cash taken,
 *     a refund of anything paid online but not supplied, the bill PDF in the patient's record, the
 *     timeline, and the store's payout lines (online money kept, minus GoKesari's commission).
 *
 * External side effects (gateway refunds, notifications) go after commit; events carry ids and statuses only.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { z } from "zod";

import { istDateKey } from "@/lib/consult/time";
import { getEnv } from "@/lib/env";
import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { haversineDistanceKm, parseCoordinates } from "@/lib/geo/haversine";
import { RX_FULFILMENTS, RX_ORDER_STATUS_LABELS, type RxOrderStatus } from "@/lib/health/constants";
import { decryptBytes, encryptBytes } from "@/lib/pan-crypto";
import { isShopOpenNow } from "@/lib/shop-hours";
import { db, type DbClient } from "@/server/db";
import {
  addresses,
  financialAdjustments,
  healthDocuments,
  healthDrugMaster,
  healthPatients,
  healthPharmacyProfiles,
  healthPrescriptionItems,
  healthPrescriptions,
  healthRxOrderItems,
  healthRxOrders,
  paymentIntents,
  paymentRefunds,
  scheduledNotices,
  shops,
  supportTickets,
  users,
  type HealthPatient,
  type HealthPharmacyProfile,
  type HealthPrescription,
  type HealthPrescriptionItem,
  type HealthRxOrder,
  type HealthRxOrderItem,
  type PaymentIntentRow,
  type ScheduledNotice,
  type Shop,
} from "@/server/db/schema";
import { createPaymentIntent, isLive, redirectUrlOf, refundPaymentIntent, type PaymentIntentRef } from "@/server/payments/intents";
import type { AfterCommit } from "@/server/payments/purpose-handlers";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify, NOTIFICATION_TYPES, type NotificationType } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { doctorStatus, firmUserIds, isHealthStaff, patientAudience, patientsForUser, requireHealthEnabled, requirePatientAccess, type HealthActor } from "./access";
import { publishHealthEvent, type HealthEventName } from "./events";
import { prescriptionView, verifyPrescription } from "./prescriptions";
import { renderRxBillPdf, type RxBillLine } from "./rx-bill";
import type { RxContent } from "./rx-pdf";
import { addTimeline, nextNumber } from "./timeline";

/* ------------------------------------------------------------ vocabulary */

export const RX_EXPIRY_KIND = "HEALTH_RX_EXPIRY";
export const RX_OTP_MAX_ATTEMPTS = 5;
export const RX_AVAILABILITIES = ["AVAILABLE", "PARTIAL", "UNAVAILABLE", "SUBSTITUTE"] as const;
export type RxAvailability = (typeof RX_AVAILABILITIES)[number];

/** Still being worked on (one per prescription and store at a time). */
const OPEN: readonly RxOrderStatus[] = ["SENT", "QUOTED", "APPROVED", "PAID", "PACKED", "READY_FOR_PICKUP", "OUT_FOR_DELIVERY"];
/** The patient may cancel until the store has packed. */
const PATIENT_CANCELLABLE: readonly RxOrderStatus[] = ["SENT", "QUOTED", "APPROVED", "PAID"];
/** The store may cancel (with a reason) any time before completion; a new request is declined instead. */
const STORE_CANCELLABLE: readonly RxOrderStatus[] = ["QUOTED", "APPROVED", "PAID", "PACKED", "READY_FOR_PICKUP", "OUT_FOR_DELIVERY"];
const TO_PACK: readonly RxOrderStatus[] = ["APPROVED", "PAID"];
const HANDOVER: readonly RxOrderStatus[] = ["READY_FOR_PICKUP", "OUT_FOR_DELIVERY"];
const RESTRICTED_SCHEDULES = ["X", "NDPS"];

const PATIENT_PATH = (id: string) => `/health/medicines/${id}`;
const STORE_PATH = (id: string) => `/shop/health/prescriptions/${id}`;

/** "₹1,234.50" for notices. */
export function inr(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

const squash = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, "");
const itemName = (i: Pick<HealthPrescriptionItem, "brandName" | "genericName" | "strength">) => `${i.brandName ?? i.genericName}${i.strength ? ` ${i.strength}` : ""}`;
const yearIst = (now: Date) => Number(new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 4));

function addressText(a: Record<string, unknown> | null | undefined): string | null {
  if (!a) return null;
  return [a.line1, a.line2, a.area, a.landmark ? `near ${String(a.landmark)}` : null, a.city, a.state, a.pincode].filter((v) => typeof v === "string" && v.trim()).join(", ");
}

function shopAddress(s: Pick<Shop, "addressLine1" | "addressLine2" | "area" | "city" | "state" | "pincode">): string {
  return [s.addressLine1, s.addressLine2, s.area, s.city, s.state, s.pincode].filter(Boolean).join(", ");
}

/* ------------------------------------------------------------ handover code */

export function newRxSalt(): string {
  return randomBytes(8).toString("hex");
}

/** The 4-digit pickup / delivery code: HMAC(AUTH_SECRET, order + salt), worked out when needed, never stored. */
export function rxHandoverCode(orderId: string, salt: string): string {
  const mac = createHmac("sha256", getEnv().AUTH_SECRET).update(`health-rx-otp:${salt}:${orderId}`).digest();
  return String(mac.readUInt32BE(0) % 10_000).padStart(4, "0");
}

function codeMatches(orderId: string, salt: string | null, entered: string): boolean {
  if (!salt) return false;
  const clean = entered.replace(/\D/g, "");
  if (clean.length !== 4) return false;
  const want = Buffer.from(rxHandoverCode(orderId, salt));
  const got = Buffer.from(clean);
  return want.length === got.length && timingSafeEqual(want, got);
}

/* ------------------------------------------------------------ loading */

async function loadOrder(orderId: string, client: DbClient = db): Promise<HealthRxOrder> {
  const [o] = await client.select().from(healthRxOrders).where(eq(healthRxOrders.id, orderId));
  if (!o) throw notFound("Medicines order");
  return o;
}

async function lockOrder(tx: DbClient, orderId: string): Promise<HealthRxOrder> {
  const [o] = await tx.select().from(healthRxOrders).where(eq(healthRxOrders.id, orderId)).for("update");
  if (!o) throw notFound("Medicines order");
  return o;
}

async function patientOf(order: Pick<HealthRxOrder, "patientId">, client: DbClient = db): Promise<HealthPatient> {
  const [p] = await client.select().from(healthPatients).where(eq(healthPatients.id, order.patientId));
  return p;
}

/** The patient side: the account holder or the linked adult of the order's patient. Anyone else: 404. */
async function requirePatientOrder(orderId: string, actor: HealthActor): Promise<{ order: HealthRxOrder; patient: HealthPatient }> {
  const order = await loadOrder(orderId);
  try {
    const patient = await requirePatientAccess(order.patientId, actor);
    return { order, patient };
  } catch {
    throw notFound("Medicines order");
  }
}

/** The store side: the owner of the store the order was sent to. Anyone else: 404. */
async function requireStoreOrder(orderId: string, actor: HealthActor): Promise<{ order: HealthRxOrder; shop: Shop }> {
  const order = await loadOrder(orderId);
  const [shop] = await db.select().from(shops).where(eq(shops.id, order.shopId));
  if (!shop || shop.ownerId !== actor.id) throw notFound("Medicines order");
  return { order, shop };
}

/** Who is asking about an order: the store it was sent to, or the patient side. Anyone else: 404. */
export async function rxOrderViewer(orderId: string, actor: HealthActor): Promise<"PATIENT" | "STORE"> {
  const order = await loadOrder(orderId);
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, order.shopId));
  if (shop?.ownerId === actor.id) return "STORE";
  await requirePatientOrder(orderId, actor);
  return "PATIENT";
}

/** The medical stores (PHARMACY shops) a user owns. */
export async function pharmacyShopsOf(userId: string): Promise<{ id: string; name: string; status: string; verification: string | null }[]> {
  const rows = await db
    .select({ id: shops.id, name: shops.name, status: shops.status, verification: healthPharmacyProfiles.verification })
    .from(shops)
    .leftJoin(healthPharmacyProfiles, eq(healthPharmacyProfiles.shopId, shops.id))
    .where(and(eq(shops.ownerId, userId), eq(shops.shopType, "PHARMACY"), isNull(shops.deletedAt)))
    .orderBy(desc(shops.createdAt));
  return rows.map((r) => ({ id: r.id, name: r.name, status: String(r.status), verification: r.verification }));
}

/* ------------------------------------------------------------ what may be ordered */

export interface OrderableItem {
  id: string;
  lineNo: number;
  name: string;
  genericName: string;
  brandName: string | null;
  strength: string | null;
  form: string;
  dose: string;
  frequency: string;
  durationDays: number;
  quantity: number;
  dispensedQty: number;
  remaining: number;
  /** Restricted / Schedule X / NDPS: never sold online. */
  restricted: boolean;
  allowed: boolean;
  reason: string | null;
}

/** Per prescription line: may it be ordered online, and how many are left. */
async function orderableItems(rx: HealthPrescription, client: DbClient = db): Promise<OrderableItem[]> {
  const items = await client.select().from(healthPrescriptionItems).where(eq(healthPrescriptionItems.prescriptionId, rx.id)).orderBy(asc(healthPrescriptionItems.lineNo));
  const drugIds = items.map((i) => i.drugId).filter((v): v is string => Boolean(v));
  const drugs = drugIds.length ? await client.select({ id: healthDrugMaster.id, online: healthDrugMaster.onlineSaleAllowed, schedule: healthDrugMaster.schedule }).from(healthDrugMaster).where(inArray(healthDrugMaster.id, drugIds)) : [];
  return items.map((i) => {
    const d = i.drugId ? drugs.find((x) => x.id === i.drugId) : null;
    const remaining = Math.max(0, i.quantity - i.dispensedQty);
    const restricted = Boolean(d && (!d.online || RESTRICTED_SCHEDULES.includes(d.schedule)));
    let reason: string | null = null;
    if (restricted) reason = "Not sold online (restricted / Schedule X / NDPS medicine). Buy it at the counter with the original prescription.";
    else if (remaining <= 0) reason = "Already supplied in full.";
    return {
      id: i.id,
      lineNo: i.lineNo,
      name: itemName(i),
      genericName: i.genericName,
      brandName: i.brandName,
      strength: i.strength,
      form: i.form,
      dose: i.dose,
      frequency: i.frequency,
      durationDays: i.durationDays,
      quantity: i.quantity,
      dispensedQty: i.dispensedQty,
      remaining,
      restricted,
      allowed: reason === null,
      reason,
    };
  });
}

function rxExpired(rx: Pick<HealthPrescription, "validUntil">, now: Date): boolean {
  return Boolean(rx.validUntil && rx.validUntil < istDateKey(now));
}

async function loadRxForPatient(prescriptionId: string, actor: HealthActor): Promise<{ rx: HealthPrescription; patient: HealthPatient }> {
  const [rx] = await db.select().from(healthPrescriptions).where(eq(healthPrescriptions.id, prescriptionId));
  if (!rx) throw notFound("Prescription");
  try {
    return { rx, patient: await requirePatientAccess(rx.patientId, actor) };
  } catch {
    throw notFound("Prescription");
  }
}

/* ------------------------------------------------------------ stores */

export interface StoreCard {
  shopId: string;
  name: string;
  area: string | null;
  city: string;
  pincode: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  distanceKm: number | null;
  open: boolean;
  ratingAvg: number | null;
  ratingCount: number;
  ownDelivery: boolean;
  deliveryRadiusKm: number;
  cashOnHandover: boolean;
  /** For the chosen address: inside the store's delivery radius (null: no address chosen). */
  deliversToAddress: boolean | null;
  favourite: boolean;
}

type StoreRow = { shop: Shop; profile: HealthPharmacyProfile | null };

function storeProblem(row: StoreRow | null | undefined): string | null {
  if (!row || row.shop.deletedAt) return "This store was not found.";
  if (row.shop.shopType !== "PHARMACY") return "This shop is not a medical store.";
  if (row.shop.status !== "APPROVED") return "This store is not live on GoKesari.";
  if (row.shop.ordersPaused) return "This store is not taking orders right now.";
  if (!row.profile || row.profile.verification !== "VERIFIED") return "This store's drug licence and pharmacist are not verified yet.";
  if (!row.profile.acceptsPrescriptions) return "This store is not taking prescriptions right now.";
  return null;
}

async function storeRow(shopId: string, client: DbClient = db): Promise<StoreRow | null> {
  const [row] = await client.select({ shop: shops, profile: healthPharmacyProfiles }).from(shops).leftJoin(healthPharmacyProfiles, eq(healthPharmacyProfiles.shopId, shops.id)).where(eq(shops.id, shopId));
  return row ?? null;
}

/** Can this store deliver to these coordinates / this PIN code? Without both locations only the same PIN code counts. */
function deliveryCheck(row: StoreRow, address: { latitude: string | null; longitude: string | null; pincode: string }): { ok: boolean; distanceKm: number | null } {
  if (!row.profile?.ownDelivery) return { ok: false, distanceKm: null };
  const from = parseCoordinates(row.shop.latitude, row.shop.longitude);
  const to = parseCoordinates(address.latitude, address.longitude);
  if (from && to) {
    const km = haversineDistanceKm(from, to);
    return { ok: km <= row.profile.deliveryRadiusKm, distanceKm: Math.round(km * 100) / 100 };
  }
  return { ok: row.shop.pincode.trim() === address.pincode.trim(), distanceKm: null };
}

/** Stores that used to serve this customer (completed orders), most recent first. */
async function favouriteShopIds(customerId: string): Promise<string[]> {
  const rows = await db
    .select({ shopId: healthRxOrders.shopId, last: sql<Date>`max(${healthRxOrders.completedAt})` })
    .from(healthRxOrders)
    .where(and(eq(healthRxOrders.customerId, customerId), eq(healthRxOrders.status, "COMPLETED")))
    .groupBy(healthRxOrders.shopId)
    .orderBy(desc(sql`max(${healthRxOrders.completedAt})`))
    .limit(10);
  return rows.map((r) => r.shopId);
}

/** Verified medical stores taking prescriptions: favourites, then nearest first (or by name without a location). */
export async function rxStores(
  input: { latitude?: number | null; longitude?: number | null; address?: { latitude: string | null; longitude: string | null; pincode: string } | null },
  actor: HealthActor,
  now: Date = new Date(),
): Promise<StoreCard[]> {
  const rows = await db
    .select({ shop: shops, profile: healthPharmacyProfiles })
    .from(shops)
    .innerJoin(healthPharmacyProfiles, eq(healthPharmacyProfiles.shopId, shops.id))
    .where(and(eq(shops.shopType, "PHARMACY"), eq(shops.status, "APPROVED"), isNull(shops.deletedAt), eq(shops.ordersPaused, false), eq(healthPharmacyProfiles.verification, "VERIFIED"), eq(healthPharmacyProfiles.acceptsPrescriptions, true)));
  const favourites = await favouriteShopIds(actor.id);
  const origin = input.latitude != null && input.longitude != null ? { latitude: input.latitude, longitude: input.longitude } : null;
  const cards: StoreCard[] = rows.map((r) => {
    const at = parseCoordinates(r.shop.latitude, r.shop.longitude);
    const distanceKm = origin && at ? Math.round(haversineDistanceKm(origin, at) * 100) / 100 : null;
    return {
      shopId: r.shop.id,
      name: r.shop.name,
      area: r.shop.area,
      city: r.shop.city,
      pincode: r.shop.pincode,
      address: shopAddress(r.shop),
      latitude: at?.latitude ?? null,
      longitude: at?.longitude ?? null,
      distanceKm,
      open: isShopOpenNow(r.shop, now),
      ratingAvg: r.shop.ratingCount > 0 ? Math.round(r.shop.ratingAvgX100) / 100 : null,
      ratingCount: r.shop.ratingCount,
      ownDelivery: r.profile.ownDelivery,
      deliveryRadiusKm: r.profile.deliveryRadiusKm,
      cashOnHandover: r.profile.cashOnHandover,
      deliversToAddress: input.address ? deliveryCheck(r, input.address).ok : null,
      favourite: favourites.includes(r.shop.id),
    };
  });
  const near = cards.filter((c) => c.favourite || c.distanceKm == null || c.distanceKm <= 50);
  near.sort((a, b) => {
    if (a.favourite !== b.favourite) return a.favourite ? -1 : 1;
    if (a.favourite && b.favourite) return favourites.indexOf(a.shopId) - favourites.indexOf(b.shopId);
    if (a.distanceKm != null && b.distanceKm != null) return a.distanceKm - b.distanceKm;
    if (a.distanceKm != null) return -1;
    if (b.distanceKm != null) return 1;
    return a.name.localeCompare(b.name);
  });
  return near.slice(0, 60);
}

/* ------------------------------------------------------------ new request: options */

export interface RxOrderOptions {
  prescription: { id: string; rxNumber: string; version: number; issuedAt: Date; validUntil: string | null; expired: boolean; doctor: string; clinic: string; patientId: string; patientName: string };
  items: OrderableItem[];
  stores: StoreCard[];
  addresses: { id: string; label: string; text: string; hasLocation: boolean; isDefault: boolean }[];
  origin: { latitude: number; longitude: number; source: "DEVICE" | "ADDRESS" } | null;
  /** "Send to another store": the earlier request's medicines and quantities (capped by what is left). */
  preselect: { prescriptionItemId: string; qty: number }[];
  responseMinutes: number;
}

export const optionsInput = z.object({
  prescriptionId: z.string().uuid(),
  latitude: z.coerce.number().min(-90).max(90).nullish(),
  longitude: z.coerce.number().min(-180).max(180).nullish(),
  addressId: z.string().uuid().nullish(),
  fromOrderId: z.string().uuid().nullish(),
});

export async function rxOrderOptions(raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<RxOrderOptions> {
  await requireHealthEnabled();
  const input = optionsInput.parse(raw);
  const { rx, patient } = await loadRxForPatient(input.prescriptionId, actor);
  const content = rx.content as unknown as RxContent;
  const items = await orderableItems(rx);
  const saved = await db.select().from(addresses).where(and(eq(addresses.userId, actor.id), isNull(addresses.deletedAt))).orderBy(desc(addresses.isDefault), desc(addresses.createdAt));
  const chosen = input.addressId ? saved.find((a) => a.id === input.addressId) ?? null : null;
  let origin: RxOrderOptions["origin"] = null;
  if (input.latitude != null && input.longitude != null) origin = { latitude: input.latitude, longitude: input.longitude, source: "DEVICE" };
  else {
    const base = chosen ?? saved.find((a) => a.isDefault) ?? saved[0] ?? null;
    const at = base ? parseCoordinates(base.latitude, base.longitude) : null;
    if (at) origin = { ...at, source: "ADDRESS" };
  }
  const stores = await rxStores({ latitude: origin?.latitude ?? null, longitude: origin?.longitude ?? null, address: chosen }, actor, now);
  let preselect: RxOrderOptions["preselect"] = [];
  if (input.fromOrderId) {
    const [prev] = await db.select().from(healthRxOrders).where(eq(healthRxOrders.id, input.fromOrderId));
    if (prev && prev.prescriptionId === rx.id && prev.patientId === patient.id) {
      const lines = await db.select().from(healthRxOrderItems).where(eq(healthRxOrderItems.rxOrderId, prev.id));
      preselect = lines
        .map((l) => {
          const it = items.find((i) => i.id === l.prescriptionItemId);
          return it && it.allowed ? { prescriptionItemId: l.prescriptionItemId, qty: Math.min(l.requestedQty, it.remaining) } : null;
        })
        .filter((v): v is { prescriptionItemId: string; qty: number } => Boolean(v && v.qty > 0));
    }
  }
  const rule = await getRule("health");
  return {
    prescription: { id: rx.id, rxNumber: rx.rxNumber, version: rx.version, issuedAt: rx.issuedAt, validUntil: rx.validUntil, expired: rxExpired(rx, now), doctor: content.doctor.name, clinic: content.clinic.name, patientId: patient.id, patientName: patient.fullName },
    items,
    stores,
    addresses: saved.map((a) => ({ id: a.id, label: a.label ?? (a.addressType === "HOME" ? "Home" : a.addressType === "WORK" ? "Work" : "Address"), text: addressText(a as unknown as Record<string, unknown>) ?? "", hasLocation: Boolean(parseCoordinates(a.latitude, a.longitude)), isDefault: a.isDefault })),
    origin,
    preselect,
    responseMinutes: rule.storeResponseMinutes,
  };
}

/* ------------------------------------------------------------ create (SENT) */

export const createRxOrderInput = z
  .object({
    prescriptionId: z.string().uuid(),
    shopId: z.string().uuid({ message: "Choose a medical store." }),
    items: z
      .array(z.object({ prescriptionItemId: z.string().uuid(), qty: z.number().int().min(1, "Quantity must be at least 1.").max(10_000) }))
      .min(1, "Choose at least one medicine.")
      .max(40),
    fulfilment: z.enum(RX_FULFILMENTS),
    pickupAt: z.string().datetime({ offset: true }).nullish(),
    addressId: z.string().uuid().nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    fromOrderId: z.string().uuid().nullish(),
  })
  .refine((v) => v.fulfilment !== "DELIVERY" || Boolean(v.addressId), { message: "Choose the delivery address.", path: ["addressId"] });
export type CreateRxOrderInput = z.input<typeof createRxOrderInput>;

export async function createRxOrder(raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<HealthRxOrder> {
  await requireHealthEnabled();
  const input = createRxOrderInput.parse(raw);
  const { rx, patient } = await loadRxForPatient(input.prescriptionId, actor);
  if (rx.status !== "ISSUED") throw conflict("This prescription was replaced by a newer version. Open the latest one.");
  if (rxExpired(rx, now)) throw conflict(`This prescription was valid until ${rx.validUntil}. Ask your doctor for a new one.`);
  const items = await orderableItems(rx);
  const seen = new Set<string>();
  for (const line of input.items) {
    if (seen.has(line.prescriptionItemId)) throw validationFailed("Each medicine can be chosen once.");
    seen.add(line.prescriptionItemId);
    const it = items.find((i) => i.id === line.prescriptionItemId);
    if (!it) throw validationFailed("A chosen medicine is not on this prescription.");
    if (!it.allowed) throw validationFailed(`${it.name}: ${it.reason}`);
    if (line.qty > it.remaining) throw validationFailed(`${it.name}: at most ${it.remaining} can be ordered (prescribed ${it.quantity}, already supplied ${it.dispensedQty}).`);
  }
  const store = await storeRow(input.shopId);
  const problem = storeProblem(store);
  if (problem || !store?.profile) throw conflict(problem ?? "This store cannot take prescriptions.");
  let addressSnap: Record<string, unknown> | null = null;
  let distanceKm: number | null = null;
  let pickupAt: Date | null = null;
  if (input.fulfilment === "DELIVERY") {
    const [a] = await db.select().from(addresses).where(and(eq(addresses.id, input.addressId!), eq(addresses.userId, actor.id), isNull(addresses.deletedAt)));
    if (!a) throw notFound("Address");
    if (!store.profile.ownDelivery) throw conflict(`${store.shop.name} does not deliver. Choose pickup or another store.`);
    const check = deliveryCheck(store, a);
    if (!check.ok) throw conflict(check.distanceKm != null ? `${store.shop.name} delivers up to ${store.profile.deliveryRadiusKm} km; this address is ${check.distanceKm} km away. Choose pickup or another store.` : `${store.shop.name} cannot confirm it delivers to this address. Set the address's map pin, or choose pickup.`);
    distanceKm = check.distanceKm;
    addressSnap = {
      addressId: a.id,
      label: a.label,
      recipientName: a.recipientName ?? patient.fullName,
      recipientPhone: a.recipientPhone ?? patient.phone ?? null,
      line1: a.line1,
      line2: a.line2,
      area: a.area,
      landmark: a.landmark,
      city: a.city,
      state: a.state,
      pincode: a.pincode,
      latitude: a.latitude,
      longitude: a.longitude,
      deliveryInstructions: a.deliveryInstructions,
    };
  } else {
    if (input.pickupAt) {
      pickupAt = new Date(input.pickupAt);
      if (pickupAt.getTime() < now.getTime() - 5 * 60_000) throw validationFailed("Choose a pickup time from now on.");
      if (pickupAt.getTime() > now.getTime() + 7 * 86_400_000) throw validationFailed("Choose a pickup time within the next 7 days.");
    }
    const from = input.latitude != null && input.longitude != null ? { latitude: input.latitude, longitude: input.longitude } : null;
    const at = parseCoordinates(store.shop.latitude, store.shop.longitude);
    if (from && at) distanceKm = Math.round(haversineDistanceKm(from, at) * 100) / 100;
  }
  const [dup] = await db
    .select({ id: healthRxOrders.id, orderNumber: healthRxOrders.orderNumber })
    .from(healthRxOrders)
    .where(and(eq(healthRxOrders.prescriptionId, rx.id), eq(healthRxOrders.shopId, store.shop.id), inArray(healthRxOrders.status, [...OPEN])))
    .limit(1);
  if (dup) throw conflict(`This prescription is already with ${store.shop.name} (order ${dup.orderNumber}).`, { reason: "ALREADY_SENT", rxOrderId: dup.id });
  const rule = await getRule("health");
  const expiresAt = new Date(now.getTime() + rule.storeResponseMinutes * 60_000);

  const order = await db.transaction(async (tx) => {
    const year = yearIst(now);
    const seq = await nextNumber(tx, `MED-${year}`);
    const [o] = await tx
      .insert(healthRxOrders)
      .values({
        orderNumber: `MED-${year}-${String(seq).padStart(6, "0")}`,
        prescriptionId: rx.id,
        patientId: patient.id,
        customerId: actor.id,
        shopId: store.shop.id,
        fulfilment: input.fulfilment,
        pickupAt,
        address: addressSnap,
        distanceKm,
        status: "SENT",
        expiresAt,
        commissionBp: rule.rxCommissionBp,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await tx.insert(healthRxOrderItems).values(input.items.map((l) => ({ rxOrderId: o.id, prescriptionItemId: l.prescriptionItemId, requestedQty: l.qty })));
    await tx
      .insert(scheduledNotices)
      .values({ kind: RX_EXPIRY_KIND, key: `health-rx-expiry:${o.id}`, dueAt: expiresAt, payload: { rxOrderId: o.id } })
      .onConflictDoUpdate({ target: scheduledNotices.key, set: { dueAt: expiresAt, sentAt: null, cancelledAt: null, updatedAt: now } });
    await timeline(tx, o, store.shop.name, input.items.length);
    await tell(tx, o, patient, "rx.forwarded", { fulfilment: o.fulfilment });
    return o;
  });
  await notifyStore(order, NOTIFICATION_TYPES.HEALTH_RX_REQUEST, `New prescription request ${order.orderNumber}`, `${patient.fullName} sent prescription ${rx.rxNumber} (${input.items.length} ${input.items.length === 1 ? "medicine" : "medicines"}) for ${input.fulfilment === "PICKUP" ? "pickup" : "delivery"}. Reply within ${rule.storeResponseMinutes} minutes.`);
  return order;
}

/* ------------------------------------------------------------ shared effects */

/** Timeline row for the order (one per order, refreshed as it moves). */
async function timeline(client: DbClient, o: HealthRxOrder, shopName: string, count?: number, extra: Record<string, unknown> = {}): Promise<void> {
  const n = count ?? (await client.select({ n: sql<number>`count(*)::int` }).from(healthRxOrderItems).where(eq(healthRxOrderItems.rxOrderId, o.id)))[0]?.n ?? 0;
  const what = `${n} ${n === 1 ? "medicine" : "medicines"} · ${o.fulfilment === "PICKUP" ? "pickup" : "delivery"}`;
  const summary =
    o.status === "COMPLETED"
      ? `${what}. Bill ${o.billNumber ?? ""} ${inr(o.totalPaise)}; saved in your documents.`
      : o.status === "SENT"
        ? `${what}. Waiting for the store to reply.`
        : `${what}. ${RX_ORDER_STATUS_LABELS[o.status as RxOrderStatus] ?? o.status}.`;
  await addTimeline(client, {
    patientId: o.patientId,
    occurredAt: o.status === "COMPLETED" ? (o.completedAt ?? o.updatedAt) : o.createdAt,
    kind: "MEDICINE_ORDER",
    title: o.status === "COMPLETED" ? `Medicines received from ${shopName} (${o.orderNumber})` : `Medicines order ${o.orderNumber} to ${shopName}`,
    summary,
    providerName: shopName,
    providerShopId: o.shopId,
    refType: "rx_order",
    refId: o.id,
    meta: { orderNumber: o.orderNumber, status: o.status, prescriptionId: o.prescriptionId, ...extra },
  });
}

/** Live event to the patient's account, the store's users and the store's screens. Ids and statuses only. */
async function tell(client: DbClient, o: HealthRxOrder, patient: HealthPatient, name: HealthEventName, extra: Record<string, unknown> = {}): Promise<void> {
  const storeUsers = await firmUserIds(o.shopId, client);
  await publishHealthEvent({ name, userIds: [...patientAudience(patient), ...storeUsers], shopId: o.shopId, subjectId: o.id, payload: { rxOrderId: o.id, status: o.status, ...extra } }, client);
}

async function notifyPatient(o: HealthRxOrder, type: NotificationType, title: string, body: string, client: DbClient = db): Promise<void> {
  const patient = await patientOf(o, client);
  if (!patient) return;
  for (const userId of patientAudience(patient)) {
    await notify({ userId, type, title, body, actionUrl: PATIENT_PATH(o.id), channels: ["PUSH"], metadata: { rxOrderId: o.id, status: o.status } }, client);
  }
}

async function notifyStore(o: HealthRxOrder, type: NotificationType, title: string, body: string, client: DbClient = db): Promise<void> {
  for (const userId of await firmUserIds(o.shopId, client)) {
    await notify({ userId, type, title, body, actionUrl: STORE_PATH(o.id), channels: ["PUSH"], metadata: { rxOrderId: o.id, status: o.status } }, client);
  }
}

async function shopName(shopId: string, client: DbClient = db): Promise<string> {
  const [s] = await client.select({ name: shops.name }).from(shops).where(eq(shops.id, shopId));
  return s?.name ?? "The store";
}

async function cancelExpiryNotice(client: DbClient, orderId: string, now: Date): Promise<void> {
  await client
    .update(scheduledNotices)
    .set({ cancelledAt: now, updatedAt: now })
    .where(and(eq(scheduledNotices.key, `health-rx-expiry:${orderId}`), isNull(scheduledNotices.sentAt), isNull(scheduledNotices.cancelledAt)));
}

async function submitRefunds(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const { submitRefund } = await import("@/server/payments/intents");
  for (const id of ids) await submitRefund(id).catch((e) => console.error("[health] rx refund submit deferred to the job", id, e instanceof Error ? e.message : e));
}

/* ------------------------------------------------------------ expiry (scheduled notice) */

async function expireInTx(tx: DbClient, o: HealthRxOrder, now: Date): Promise<HealthRxOrder | null> {
  if (o.status !== "SENT" || o.expiresAt.getTime() > now.getTime()) return null;
  const [u] = await tx.update(healthRxOrders).set({ status: "EXPIRED", decidedAt: now, updatedAt: now }).where(eq(healthRxOrders.id, o.id)).returning();
  const patient = await patientOf(u, tx);
  await timeline(tx, u, await shopName(u.shopId, tx));
  await tell(tx, u, patient, "rx.expired");
  return u;
}

async function afterExpiry(u: HealthRxOrder): Promise<void> {
  const name = await shopName(u.shopId);
  await notifyPatient(u, NOTIFICATION_TYPES.HEALTH_RX_EXPIRED, "No reply from the store", `${name} did not reply to ${u.orderNumber} in time. Send it to another store from My Health — your choice of medicines is kept.`);
  await notifyStore(u, NOTIFICATION_TYPES.HEALTH_RX_EXPIRED, `Request ${u.orderNumber} expired`, `You did not reply in time, so the customer was offered other stores.`);
}

/** HEALTH_RX_EXPIRY: the store did not reply in time. True: expired now; false: nothing to do. */
export async function expireRxOrderNotice(notice: ScheduledNotice, now: Date = new Date()): Promise<boolean> {
  const orderId = notice.payload.rxOrderId;
  if (!orderId) return false;
  const expired = await db.transaction(async (tx) => {
    const [o] = await tx.select().from(healthRxOrders).where(eq(healthRxOrders.id, orderId)).for("update");
    if (!o) return null;
    return expireInTx(tx, o, now);
  });
  if (!expired) return false;
  await afterExpiry(expired);
  return true;
}

/* ------------------------------------------------------------ store: quote / decline */

export const quoteInput = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        availability: z.enum(RX_AVAILABILITIES),
        quotedQty: z.number().int().min(0).max(10_000).nullish(),
        unitPricePaise: z.number().int().min(0).max(100_000_000).nullish(),
        discountPaise: z.number().int().min(0).max(100_000_000).nullish(),
        substituteName: z.string().trim().max(160).nullish(),
        substituteGeneric: z.string().trim().max(160).nullish(),
        substituteStrength: z.string().trim().max(60).nullish(),
      }),
    )
    .min(1)
    .max(40),
  deliveryPaise: z.number().int().min(0).max(10_000_000).default(0),
});
export type QuoteInput = z.input<typeof quoteInput>;

export async function quoteRxOrder(orderId: string, raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<HealthRxOrder> {
  const input = quoteInput.parse(raw);
  const { order: before } = await requireStoreOrder(orderId, actor);
  if (before.status !== "SENT") throw conflict("This request was already answered or has closed.");
  const lines = await db.select().from(healthRxOrderItems).where(eq(healthRxOrderItems.rxOrderId, before.id));
  const rxItems = await db.select().from(healthPrescriptionItems).where(inArray(healthPrescriptionItems.id, lines.map((l) => l.prescriptionItemId)));
  if (input.items.length !== lines.length || new Set(input.items.map((i) => i.id)).size !== lines.length) throw validationFailed("Answer every medicine on the request once.");
  const priced: (Partial<HealthRxOrderItem> & { id: string })[] = [];
  for (const q of input.items) {
    const line = lines.find((l) => l.id === q.id);
    if (!line) throw validationFailed("A line is not on this request.");
    const it = rxItems.find((i) => i.id === line.prescriptionItemId)!;
    const name = itemName(it);
    const unit = q.unitPricePaise ?? 0;
    const discount = q.discountPaise ?? 0;
    let qty: number;
    switch (q.availability) {
      case "AVAILABLE":
        qty = line.requestedQty;
        if (q.quotedQty != null && q.quotedQty !== line.requestedQty) throw validationFailed(`${name}: use "Partly available" for a smaller quantity.`);
        break;
      case "PARTIAL":
        qty = q.quotedQty ?? 0;
        if (qty < 1 || qty >= line.requestedQty) throw validationFailed(`${name}: a partial quantity is between 1 and ${line.requestedQty - 1}.`);
        break;
      case "UNAVAILABLE":
        qty = 0;
        break;
      case "SUBSTITUTE": {
        qty = q.quotedQty ?? line.requestedQty;
        if (qty < 1 || qty > line.requestedQty) throw validationFailed(`${name}: the substitute quantity is between 1 and ${line.requestedQty}.`);
        if (!q.substituteName || q.substituteName.length < 2) throw validationFailed(`${name}: enter the substitute's brand name.`);
        if (squash(q.substituteGeneric) !== squash(it.genericName) || squash(q.substituteStrength) !== squash(it.strength)) {
          throw validationFailed(`${name}: a substitute must be the same medicine (${it.genericName}) and strength (${it.strength ?? "as prescribed"}).`);
        }
        break;
      }
    }
    if (qty > 0 && unit <= 0) throw validationFailed(`${name}: enter the price.`);
    if (discount > unit * qty) throw validationFailed(`${name}: the discount is more than the line's value.`);
    priced.push({
      id: line.id,
      availability: q.availability,
      quotedQty: qty,
      substituteName: q.availability === "SUBSTITUTE" ? q.substituteName! : null,
      substituteGeneric: q.availability === "SUBSTITUTE" ? it.genericName : null,
      substituteStrength: q.availability === "SUBSTITUTE" ? it.strength : null,
      substituteApproved: null,
      unitPricePaise: qty > 0 ? unit : 0,
      discountPaise: qty > 0 ? discount : 0,
      lineTotalPaise: qty > 0 ? unit * qty - discount : 0,
    });
  }
  if (!priced.some((p) => (p.quotedQty ?? 0) > 0)) throw validationFailed("Nothing is available — decline the request with a reason instead.");
  const delivery = before.fulfilment === "DELIVERY" ? input.deliveryPaise : 0;

  const result = await db.transaction(async (tx) => {
    const o = await lockOrder(tx, orderId);
    const expired = await expireInTx(tx, o, now);
    if (expired) return { expired };
    if (o.status !== "SENT") throw conflict("This request was already answered or has closed.");
    for (const p of priced) {
      const { id, ...set } = p;
      await tx.update(healthRxOrderItems).set(set).where(eq(healthRxOrderItems.id, id));
    }
    const totals = totalsOf(await tx.select().from(healthRxOrderItems).where(eq(healthRxOrderItems.rxOrderId, o.id)), delivery);
    const [u] = await tx
      .update(healthRxOrders)
      .set({ status: "QUOTED", quotedAt: now, ...totals, updatedAt: now })
      .where(eq(healthRxOrders.id, o.id))
      .returning();
    await cancelExpiryNotice(tx, o.id, now);
    const patient = await patientOf(u, tx);
    await timeline(tx, u, await shopName(u.shopId, tx));
    await tell(tx, u, patient, "rx.quoted", { totalPaise: u.totalPaise });
    return { order: u };
  });
  if (result.expired) {
    await afterExpiry(result.expired);
    throw conflict("The time to reply has passed; the customer was offered other stores.", { reason: "EXPIRED" });
  }
  const u = result.order!;
  const substitutes = priced.filter((p) => p.availability === "SUBSTITUTE").length;
  await notifyPatient(u, NOTIFICATION_TYPES.HEALTH_RX_QUOTED, "Your medicines quote is ready", `${await shopName(u.shopId)} replied to ${u.orderNumber}: ${inr(u.totalPaise)}${substitutes ? `, with ${substitutes} substitute${substitutes === 1 ? "" : "s"} for you to approve` : ""}. Approve it in My Health.`);
  return u;
}

function totalsOf(lines: Pick<HealthRxOrderItem, "quotedQty" | "unitPricePaise" | "discountPaise">[], deliveryPaise: number): { goodsPaise: number; discountPaise: number; deliveryPaise: number; totalPaise: number } {
  const live = lines.filter((l) => l.quotedQty > 0);
  const goods = live.reduce((n, l) => n + l.unitPricePaise * l.quotedQty, 0);
  const discount = live.reduce((n, l) => n + l.discountPaise, 0);
  return { goodsPaise: goods, discountPaise: discount, deliveryPaise, totalPaise: Math.max(0, goods - discount + deliveryPaise) };
}

export async function declineRxOrder(orderId: string, reason: string | null, actor: HealthActor, now: Date = new Date()): Promise<HealthRxOrder> {
  const why = (reason ?? "").trim();
  if (why.length < 3) throw validationFailed("Tell the customer why (for example: medicines out of stock).");
  await requireStoreOrder(orderId, actor);
  const u = await db.transaction(async (tx) => {
    const o = await lockOrder(tx, orderId);
    if (o.status !== "SENT") throw conflict("Only a new request can be declined. Cancel an accepted order instead.");
    const [d] = await tx.update(healthRxOrders).set({ status: "DECLINED", declineReason: why.slice(0, 500), decidedAt: now, updatedAt: now }).where(eq(healthRxOrders.id, o.id)).returning();
    await cancelExpiryNotice(tx, o.id, now);
    const patient = await patientOf(d, tx);
    await timeline(tx, d, await shopName(d.shopId, tx));
    await tell(tx, d, patient, "rx.declined");
    return d;
  });
  await notifyPatient(u, NOTIFICATION_TYPES.HEALTH_RX_DECLINED, "The store could not take your request", `${await shopName(u.shopId)} declined ${u.orderNumber}: ${why.slice(0, 200)}. Send it to another store from My Health.`);
  return u;
}

/* ------------------------------------------------------------ patient: approve / pay */

export const approveInput = z.object({
  /** One decision per substitute line: rx_order_items.id → approved. */
  substitutes: z.record(z.string(), z.boolean()).default({}),
  paymentMode: z.enum(["ONLINE", "CASH_ON_HANDOVER"]),
});

export async function approveRxOrder(orderId: string, raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<{ order: HealthRxOrder; checkoutUrl: string | null; intentId: string | null }> {
  const input = approveInput.parse(raw);
  const { order: before } = await requirePatientOrder(orderId, actor);
  if (before.status !== "QUOTED") throw conflict("Only a quoted order can be approved.");
  if (before.paymentStatus === "PAID") throw conflict("This order is already paid.");
  const store = await storeRow(before.shopId);
  if (input.paymentMode === "CASH_ON_HANDOVER" && !store?.profile?.cashOnHandover) throw conflict("This store takes online payment only.");
  const lines = await db.select().from(healthRxOrderItems).where(eq(healthRxOrderItems.rxOrderId, before.id));
  for (const l of lines) {
    if (l.availability === "SUBSTITUTE" && l.substituteApproved === null && typeof input.substitutes[l.id] !== "boolean") {
      throw validationFailed("Approve or reject each substitute.", { reason: "SUBSTITUTE_DECISION", lineId: l.id });
    }
  }

  const u = await db.transaction(async (tx) => {
    const o = await lockOrder(tx, orderId);
    if (o.status !== "QUOTED" || o.paymentStatus === "PAID") throw conflict("This order changed. Please reload it.");
    const fresh = await tx.select().from(healthRxOrderItems).where(eq(healthRxOrderItems.rxOrderId, o.id));
    for (const l of fresh) {
      if (l.availability !== "SUBSTITUTE" || l.substituteApproved !== null) continue;
      const yes = input.substitutes[l.id] === true;
      await tx
        .update(healthRxOrderItems)
        .set(yes ? { substituteApproved: true } : { substituteApproved: false, quotedQty: 0, lineTotalPaise: 0, discountPaise: 0 })
        .where(eq(healthRxOrderItems.id, l.id));
    }
    const after = await tx.select().from(healthRxOrderItems).where(eq(healthRxOrderItems.rxOrderId, o.id));
    const totals = totalsOf(after, o.deliveryPaise);
    if (!after.some((l) => l.quotedQty > 0)) throw conflict("Nothing is left to buy on this order. Cancel it and send the prescription to another store.");
    const cash = input.paymentMode === "CASH_ON_HANDOVER";
    const [n] = await tx
      .update(healthRxOrders)
      .set({ ...totals, paymentMode: input.paymentMode, paymentStatus: cash ? "DUE_ON_HANDOVER" : "PENDING", status: cash ? "APPROVED" : "QUOTED", decidedAt: now, updatedAt: now })
      .where(eq(healthRxOrders.id, o.id))
      .returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_RX_ORDER, entityType: "health_rx_order", entityId: o.id, newValue: { event: "approved", paymentMode: input.paymentMode, totalPaise: n.totalPaise } }, tx);
    if (cash) {
      const patient = await patientOf(n, tx);
      await timeline(tx, n, await shopName(n.shopId, tx));
      await tell(tx, n, patient, "rx.approved", { paymentMode: n.paymentMode });
    }
    return n;
  });
  if (u.status === "APPROVED") {
    const patient = await patientOf(u);
    await notifyStore(u, NOTIFICATION_TYPES.HEALTH_RX_APPROVED, `Order ${u.orderNumber} approved — please pack it`, `${patient?.fullName ?? "The customer"} approved ${u.orderNumber} (${inr(u.totalPaise)}, cash at handover). Please pack it.`);
    return { order: u, checkoutUrl: null, intentId: null };
  }
  const started = await startRxPayment(u, actor);
  return { order: started.order, checkoutUrl: started.checkoutUrl, intentId: started.intentId };
}

/** Online payment for a quoted order (approve → pay, or "Pay again" after a failed payment). */
export async function startRxPayment(order: HealthRxOrder, actor: HealthActor): Promise<{ order: HealthRxOrder; checkoutUrl: string | null; intentId: string }> {
  if (order.status !== "QUOTED" || order.paymentMode !== "ONLINE") throw conflict("Approve the quote with online payment first.");
  if (order.paymentStatus === "PAID") throw conflict("This order is already paid.");
  const amount = order.totalPaise;
  if (amount <= 0) throw conflict("Nothing is due online on this order.");
  if (order.paymentIntentId) {
    const [current] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, order.paymentIntentId));
    if (current && isLive(current) && current.amountPaise === amount && current.userId === actor.id) return { order, checkoutUrl: redirectUrlOf(current), intentId: current.id };
  }
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentIntents)
    .where(and(eq(paymentIntents.purpose, "HEALTH_RX_ORDER"), eq(paymentIntents.referenceId, order.id)));
  const [u] = await db.select({ name: users.name, email: users.email, phone: users.phone }).from(users).where(eq(users.id, actor.id));
  const created = await createPaymentIntent({
    purpose: "HEALTH_RX_ORDER",
    referenceId: order.id,
    userId: actor.id,
    amountPaise: amount,
    customer: { id: actor.id, name: u?.name ?? "GoKesari customer", email: u?.email ?? null, phone: u?.phone ?? null },
    description: `GoKesari medicines ${order.orderNumber}`,
    idempotencyKey: `healthrx:${order.id}:pay:${n}`,
    mode: "CHECKOUT",
    returnPath: PATIENT_PATH(order.id),
  });
  const [updated] = await db.update(healthRxOrders).set({ paymentIntentId: created.intent.id, paymentStatus: "PENDING", updatedAt: new Date() }).where(eq(healthRxOrders.id, order.id)).returning();
  const checkoutUrl = created.checkout ? (created.checkout.kind === "HOSTED_URL" ? created.checkout.url : (created.checkout.url ?? null)) : created.linkUrl;
  return { order: updated, checkoutUrl, intentId: created.intent.id };
}

export async function payRxOrder(orderId: string, actor: HealthActor): Promise<{ order: HealthRxOrder; checkoutUrl: string | null; intentId: string }> {
  const { order } = await requirePatientOrder(orderId, actor);
  return startRxPayment(order, actor);
}

/* ------------------------------------------------------------ payment handlers */

/** Purpose handler (purpose-handlers.ts), inside the capture transaction. */
export async function onRxOrderPaymentCaptured(intent: PaymentIntentRef, client: DbClient, afterCommit?: AfterCommit): Promise<void> {
  const [o] = await client.select().from(healthRxOrders).where(eq(healthRxOrders.id, intent.referenceId)).for("update");
  if (!o) return;
  if (o.paymentIntentId === intent.id && o.paymentStatus === "PAID") return; // applied already
  const lateKey = `healthrx:${o.id}:refund:late:${intent.id}`;
  const [lateDone] = await client.select({ id: paymentRefunds.id }).from(paymentRefunds).where(eq(paymentRefunds.idempotencyKey, lateKey));
  if (lateDone) return;
  const now = new Date();
  const fresh = o.status === "QUOTED" && o.paymentMode === "ONLINE" && o.paymentIntentId === intent.id && intent.amountPaise === o.totalPaise;
  if (fresh) {
    const [u] = await client
      .update(healthRxOrders)
      .set({ status: "PAID", paymentStatus: "PAID", paidOnlinePaise: o.paidOnlinePaise + intent.amountPaise, decidedAt: o.decidedAt ?? now, updatedAt: now })
      .where(eq(healthRxOrders.id, o.id))
      .returning();
    await recordAudit({ action: AUDIT_ACTIONS.HEALTH_RX_ORDER, entityType: "health_rx_order", entityId: o.id, newValue: { event: "paid_online", intentId: intent.id, amountPaise: intent.amountPaise } }, client);
    const patient = await patientOf(u, client);
    await timeline(client, u, await shopName(u.shopId, client));
    await tell(client, u, patient, "rx.approved", { paymentMode: "ONLINE" });
    await notifyStore(u, NOTIFICATION_TYPES.HEALTH_RX_APPROVED, `Order ${u.orderNumber} paid — please pack it`, `${patient?.fullName ?? "The customer"} paid ${inr(intent.amountPaise)} online for ${u.orderNumber}. Please pack it.`, client);
    return;
  }
  // A payment that no longer fits the order (cancelled, replaced by a newer payment, amount changed): refund it all.
  const [withMoney] = await client.update(healthRxOrders).set({ paidOnlinePaise: o.paidOnlinePaise + intent.amountPaise, updatedAt: now }).where(eq(healthRxOrders.id, o.id)).returning();
  const r = await refundRxMoney(client, withMoney, intent.amountPaise, `${o.orderNumber}: payment received after the order changed`, "late", intent.id);
  if (["CANCELLED", "DECLINED", "EXPIRED"].includes(o.status)) await client.update(healthRxOrders).set({ paymentStatus: "REFUNDED" }).where(eq(healthRxOrders.id, o.id));
  await recordAudit({ action: AUDIT_ACTIONS.HEALTH_RX_ORDER, entityType: "health_rx_order", entityId: o.id, newValue: { event: "late_payment_refunded", intentId: intent.id, amountPaise: intent.amountPaise, status: o.status } }, client);
  await notifyPatient(r.order, NOTIFICATION_TYPES.HEALTH_RX_DECLINED, "Your payment is being refunded", `We received ${inr(intent.amountPaise)} for ${o.orderNumber} after the order had changed, so the whole amount is being refunded to the way you paid.`, client);
  if (r.refundIds.length && afterCommit) afterCommit(() => submitRefunds(r.refundIds));
}

/** Purpose handler for a failed / expired payment (ended-handlers.ts): the patient can pay again. */
export async function onRxOrderPaymentEnded(intent: PaymentIntentRow, to: "FAILED" | "EXPIRED", client: DbClient): Promise<void> {
  const [o] = await client.select().from(healthRxOrders).where(eq(healthRxOrders.id, intent.referenceId)).for("update");
  if (!o || o.paymentIntentId !== intent.id || o.paymentStatus !== "PENDING") return;
  await client.update(healthRxOrders).set({ paymentStatus: "FAILED", updatedAt: new Date() }).where(eq(healthRxOrders.id, o.id));
  await recordAudit({ action: AUDIT_ACTIONS.HEALTH_RX_ORDER, entityType: "health_rx_order", entityId: o.id, newValue: { event: `payment_${to.toLowerCase()}`, intentId: intent.id } }, client);
}

/**
 * Records refunds of `amount` against the order's captured payments inside the caller's transaction
 * (the current payment first). The caller sends the returned refund ids to the gateway after commit.
 */
async function refundRxMoney(client: DbClient, order: HealthRxOrder, amount: number, reason: string, tag: string, onlyIntentId?: string): Promise<{ order: HealthRxOrder; refundIds: string[] }> {
  if (amount <= 0) return { order, refundIds: [] };
  const intents = await client
    .select()
    .from(paymentIntents)
    .where(and(eq(paymentIntents.purpose, "HEALTH_RX_ORDER"), eq(paymentIntents.referenceId, order.id), inArray(paymentIntents.status, ["CAPTURED", "PARTIALLY_REFUNDED"])));
  const ordered = intents.filter((i) => !onlyIntentId || i.id === onlyIntentId).sort((a, b) => (a.id === order.paymentIntentId ? -1 : b.id === order.paymentIntentId ? 1 : 0));
  let left = amount;
  const refundIds: string[] = [];
  for (const intent of ordered) {
    const [{ committed }] = await client
      .select({ committed: sql<number>`coalesce(sum(${paymentRefunds.amountPaise}), 0)::bigint` })
      .from(paymentRefunds)
      .where(and(eq(paymentRefunds.intentId, intent.id), inArray(paymentRefunds.status, ["PENDING", "SUCCESS"])));
    const take = Math.min(intent.amountPaise - Number(committed), left);
    if (take <= 0) continue;
    const ref = await refundPaymentIntent({ intentId: intent.id, amountPaise: take, reason: reason.slice(0, 480), idempotencyKey: `healthrx:${order.id}:refund:${tag}:${intent.id}` }, client);
    refundIds.push(ref.id);
    left -= take;
    if (left <= 0) break;
  }
  const refunded = amount - left;
  if (refunded <= 0) return { order, refundIds };
  const [u] = await client.update(healthRxOrders).set({ refundPaise: order.refundPaise + refunded, updatedAt: new Date() }).where(eq(healthRxOrders.id, order.id)).returning();
  await recordAudit({ action: AUDIT_ACTIONS.HEALTH_RX_ORDER, entityType: "health_rx_order", entityId: order.id, newValue: { event: "refund", amountPaise: refunded, refundIds, tag } }, client);
  return { order: u, refundIds };
}

/* ------------------------------------------------------------ store: pack / ready / dispatch */

export async function packRxOrder(orderId: string, actor: HealthActor, now: Date = new Date()): Promise<HealthRxOrder> {
  await requireStoreOrder(orderId, actor);
  return db.transaction(async (tx) => {
    const o = await lockOrder(tx, orderId);
    if (!TO_PACK.includes(o.status as RxOrderStatus)) throw conflict(o.status === "QUOTED" ? "Wait for the customer to approve (and pay for) the order." : "This order cannot be packed now.");
    const [u] = await tx.update(healthRxOrders).set({ status: "PACKED", packedAt: now, updatedAt: now }).where(eq(healthRxOrders.id, o.id)).returning();
    await timeline(tx, u, await shopName(u.shopId, tx));
    await tell(tx, u, await patientOf(u, tx), "order.packed");
    return u;
  });
}

async function moveToHandover(orderId: string, actor: HealthActor, to: "READY_FOR_PICKUP" | "OUT_FOR_DELIVERY", extra: { deliveryPerson?: string; deliveryPhone?: string }, now: Date): Promise<HealthRxOrder> {
  await requireStoreOrder(orderId, actor);
  const u = await db.transaction(async (tx) => {
    const o = await lockOrder(tx, orderId);
    if (![...TO_PACK, "PACKED"].includes(o.status as RxOrderStatus)) throw conflict(o.status === "QUOTED" ? "Wait for the customer to approve (and pay for) the order." : "This order cannot move to handover now.");
    if (to === "READY_FOR_PICKUP" && o.fulfilment !== "PICKUP") throw conflict("This order is for delivery: send it out for delivery instead.");
    if (to === "OUT_FOR_DELIVERY" && o.fulfilment !== "DELIVERY") throw conflict("This order is for pickup: mark it ready for pickup instead.");
    const [n] = await tx
      .update(healthRxOrders)
      .set({
        status: to,
        packedAt: o.packedAt ?? now,
        readyAt: to === "READY_FOR_PICKUP" ? now : o.readyAt,
        dispatchedAt: to === "OUT_FOR_DELIVERY" ? now : o.dispatchedAt,
        deliveryPerson: extra.deliveryPerson ?? o.deliveryPerson,
        deliveryPhone: extra.deliveryPhone ?? o.deliveryPhone,
        otpSalt: o.otpSalt ?? newRxSalt(),
        otpAttempts: 0,
        updatedAt: now,
      })
      .where(eq(healthRxOrders.id, o.id))
      .returning();
    const patient = await patientOf(n, tx);
    await timeline(tx, n, await shopName(n.shopId, tx));
    await tell(tx, n, patient, to === "READY_FOR_PICKUP" ? "order.ready_for_pickup" : "order.out_for_delivery");
    return n;
  });
  const name = await shopName(u.shopId);
  if (to === "READY_FOR_PICKUP") {
    await notifyPatient(u, NOTIFICATION_TYPES.HEALTH_RX_READY, "Your medicines are ready for pickup", `Order ${u.orderNumber} is ready at ${name}. Show your pickup code (in My Health) at the counter${u.paymentMode === "CASH_ON_HANDOVER" ? ` and pay ${inr(u.totalPaise)}` : ""}.`);
  } else {
    await notifyPatient(u, NOTIFICATION_TYPES.HEALTH_RX_OUT_FOR_DELIVERY, "Your medicines are on the way", `Order ${u.orderNumber} from ${name} is out for delivery with ${u.deliveryPerson} (${u.deliveryPhone}). Give your delivery code (in My Health) only when you have the medicines${u.paymentMode === "CASH_ON_HANDOVER" ? ` and pay ${inr(u.totalPaise)}` : ""}.`);
  }
  return u;
}

export async function readyRxOrder(orderId: string, actor: HealthActor, now: Date = new Date()): Promise<HealthRxOrder> {
  return moveToHandover(orderId, actor, "READY_FOR_PICKUP", {}, now);
}

export const dispatchInput = z.object({
  deliveryPerson: z.string().trim().min(2, "Enter the delivery person's name.").max(80),
  deliveryPhone: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s-]/g, "").replace(/^\+?91/, ""))
    .refine((v) => /^[6-9]\d{9}$/.test(v), "Enter a 10-digit mobile number."),
});

export async function dispatchRxOrder(orderId: string, raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<HealthRxOrder> {
  const input = dispatchInput.parse(raw);
  return moveToHandover(orderId, actor, "OUT_FOR_DELIVERY", input, now);
}

/** The patient asks for a new handover code (e.g. after too many wrong tries). */
export async function newRxCode(orderId: string, actor: HealthActor): Promise<HealthRxOrder> {
  const { order } = await requirePatientOrder(orderId, actor);
  if (!HANDOVER.includes(order.status as RxOrderStatus)) throw conflict("A code is given once the order is ready for pickup or out for delivery.");
  const [u] = await db.update(healthRxOrders).set({ otpSalt: newRxSalt(), otpAttempts: 0, updatedAt: new Date() }).where(eq(healthRxOrders.id, order.id)).returning();
  return u;
}

/* ------------------------------------------------------------ store: complete (bill, dispensed, settlement) */

export const completeInput = z.object({
  code: z.string().trim().min(4, "Enter the customer's 4-digit code.").max(8),
  billNumber: z.string().trim().min(1, "Enter your bill number.").max(40),
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        dispensedQty: z.number().int().min(0).max(10_000),
        batchNumber: z.string().trim().max(40).nullish(),
        expiryDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Expiry as YYYY-MM-DD.")
          .nullish(),
      }),
    )
    .min(1)
    .max(40),
});
export type CompleteInput = z.input<typeof completeInput>;

export async function completeRxOrder(orderId: string, raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<HealthRxOrder> {
  const input = completeInput.parse(raw);
  const { order: before, shop } = await requireStoreOrder(orderId, actor);
  if (!HANDOVER.includes(before.status as RxOrderStatus)) throw conflict("Complete the order at handover (ready for pickup or out for delivery).");
  if (before.otpAttempts >= RX_OTP_MAX_ATTEMPTS) throw conflict("Too many wrong codes. Ask the customer to tap 'New code' on their order, then try again.", { reason: "OTP_LOCKED" });
  if (!codeMatches(before.id, before.otpSalt, input.code)) {
    await db.update(healthRxOrders).set({ otpAttempts: sql`${healthRxOrders.otpAttempts} + 1`, updatedAt: now }).where(eq(healthRxOrders.id, before.id));
    const left = RX_OTP_MAX_ATTEMPTS - before.otpAttempts - 1;
    throw new AppError("VALIDATION_FAILED", left > 0 ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left. Ask the customer for the code on their order.` : "That code is not right. No tries left: the customer must get a new code.", { reason: "OTP_WRONG", left });
  }
  const lines = await db.select().from(healthRxOrderItems).where(eq(healthRxOrderItems.rxOrderId, before.id));
  const today = istDateKey(now);
  const plan: { line: HealthRxOrderItem; dispensed: number; batch: string | null; expiry: string | null }[] = [];
  for (const l of lines) {
    const given = input.items.find((i) => i.id === l.id);
    if (l.quotedQty === 0) {
      if (given && given.dispensedQty > 0) throw validationFailed("A line that was not quoted (or a rejected substitute) cannot be supplied.");
      plan.push({ line: l, dispensed: 0, batch: null, expiry: null });
      continue;
    }
    if (!given) throw validationFailed("Fill in every quoted medicine (0 if you could not supply it).");
    if (given.dispensedQty > l.quotedQty) throw validationFailed(`At most ${l.quotedQty} of a line can be supplied (the quoted quantity).`);
    if (given.dispensedQty > 0) {
      if (!given.batchNumber) throw validationFailed("Enter the batch number of each medicine supplied.");
      if (!given.expiryDate) throw validationFailed("Enter the expiry date of each medicine supplied.");
      if (given.expiryDate < today) throw validationFailed(`Batch ${given.batchNumber} expired on ${given.expiryDate}. Do not supply expired medicine.`);
    }
    plan.push({ line: l, dispensed: given.dispensedQty, batch: given.dispensedQty > 0 ? given.batchNumber! : null, expiry: given.dispensedQty > 0 ? given.expiryDate! : null });
  }
  if (!plan.some((p) => p.dispensed > 0)) throw validationFailed("Nothing was supplied. Cancel the order with a reason instead.");

  const result = await db.transaction(async (tx) => {
    const o = await lockOrder(tx, orderId);
    if (!HANDOVER.includes(o.status as RxOrderStatus)) throw conflict("This order changed. Please reload it.");
    // Billed amounts: a line supplied short is billed for what was supplied (discount pro rata).
    let goods = 0;
    let discount = 0;
    const billLines: RxBillLine[] = [];
    const rxItems = await tx.select().from(healthPrescriptionItems).where(inArray(healthPrescriptionItems.id, plan.map((p) => p.line.prescriptionItemId)));
    for (const p of plan) {
      const l = p.line;
      const lineDiscount = l.quotedQty > 0 ? Math.round((l.discountPaise * p.dispensed) / l.quotedQty) : 0;
      const amount = l.unitPricePaise * p.dispensed - lineDiscount;
      goods += l.unitPricePaise * p.dispensed;
      discount += lineDiscount;
      await tx.update(healthRxOrderItems).set({ dispensedQty: p.dispensed, batchNumber: p.batch, expiryDate: p.expiry }).where(eq(healthRxOrderItems.id, l.id));
      if (p.dispensed > 0) {
        const it = rxItems.find((i) => i.id === l.prescriptionItemId)!;
        billLines.push({
          name: l.availability === "SUBSTITUTE" ? (l.substituteName ?? itemName(it)) : itemName(it),
          note: l.availability === "SUBSTITUTE" ? `Substitute for ${itemName(it)} (${it.genericName}${it.strength ? ` ${it.strength}` : ""})` : null,
          batchNumber: p.batch,
          expiryDate: p.expiry,
          qty: p.dispensed,
          unitPricePaise: l.unitPricePaise,
          discountPaise: lineDiscount,
          amountPaise: amount,
        });
      }
    }
    // The prescription's dispensed quantities: guarded so they can never pass the prescribed quantity.
    for (const p of [...plan].filter((x) => x.dispensed > 0).sort((a, b) => a.line.prescriptionItemId.localeCompare(b.line.prescriptionItemId))) {
      const rows = await tx.execute<{ id: string }>(sql`
        update health.prescription_items set dispensed_qty = dispensed_qty + ${p.dispensed}
         where id = ${p.line.prescriptionItemId} and dispensed_qty + ${p.dispensed} <= quantity
        returning id`);
      if (!rows.length) {
        throw conflict("This would supply more than the doctor prescribed (another store has already supplied some of it). Reduce the quantity.", { reason: "OVER_DISPENSE", lineId: p.line.id });
      }
    }
    const delivery = o.deliveryPaise;
    const billed = Math.max(0, goods - discount + delivery);
    const cash = o.paymentMode === "CASH_ON_HANDOVER";
    let n: HealthRxOrder = (
      await tx
        .update(healthRxOrders)
        .set({
          status: "COMPLETED",
          completedAt: now,
          billNumber: input.billNumber,
          goodsPaise: goods,
          discountPaise: discount,
          totalPaise: billed,
          paidOfflinePaise: cash ? billed : o.paidOfflinePaise,
          paymentStatus: "PAID",
          updatedAt: now,
        })
        .where(eq(healthRxOrders.id, o.id))
        .returning()
    )[0];
    // Paid online for more than was supplied: the difference goes back.
    const refundIds: string[] = [];
    const over = n.paidOnlinePaise - n.refundPaise - (cash ? 0 : billed);
    if (!cash && over > 0) {
      const r = await refundRxMoney(tx, n, over, `${o.orderNumber}: medicines not supplied`, "short");
      n = r.order;
      refundIds.push(...r.refundIds);
    }
    // The bill in the patient's record.
    const [patient] = await tx.select().from(healthPatients).where(eq(healthPatients.id, n.patientId));
    const [rx] = await tx.select().from(healthPrescriptions).where(eq(healthPrescriptions.id, n.prescriptionId));
    const [profile] = await tx.select().from(healthPharmacyProfiles).where(eq(healthPharmacyProfiles.shopId, n.shopId));
    const content = rx.content as unknown as RxContent;
    const pdf = renderRxBillPdf({
      store: { name: shop.name, address: shopAddress(shop), phone: shop.contactPhone ?? shop.phone ?? null, gstin: shop.gstin ?? null, drugLicence: profile?.drugLicenceNumber ?? "-", pharmacist: profile?.pharmacistName ?? "-", pharmacistRegistration: profile?.pharmacistRegistrationNumber ?? "-" },
      billNumber: input.billNumber,
      orderNumber: n.orderNumber,
      billedAt: now,
      patientName: patient.fullName,
      prescription: { rxNumber: rx.rxNumber, doctor: content.doctor.name, registration: `${content.doctor.registrationNumber}, ${content.doctor.council}` },
      fulfilment: n.fulfilment as "PICKUP" | "DELIVERY",
      address: addressText(n.address),
      deliveredBy: n.deliveryPerson,
      lines: billLines,
      goodsPaise: goods,
      discountPaise: discount,
      deliveryPaise: delivery,
      totalPaise: billed,
      paidOnlinePaise: n.paidOnlinePaise,
      paidCashPaise: n.paidOfflinePaise,
      refundPaise: n.refundPaise,
    });
    const [doc] = await tx
      .insert(healthDocuments)
      .values({
        patientId: n.patientId,
        uploadedBy: actor.id,
        source: "STORE",
        kind: "BILL",
        title: `Medicines bill ${input.billNumber} — ${shop.name} (${n.orderNumber})`.slice(0, 200),
        documentDate: istDateKey(now),
        prescriptionId: n.prescriptionId,
        providerName: shop.name,
        fileName: `${n.orderNumber}-bill.pdf`,
        contentType: "application/pdf",
        sizeBytes: pdf.length,
        data: encryptBytes(pdf),
      })
      .returning({ id: healthDocuments.id });
    await timeline(tx, n, shop.name, undefined, { documentId: doc.id });
    n = await settleRxOrder(tx, n, now);
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_RX_ORDER, entityType: "health_rx_order", entityId: n.id, newValue: { event: "completed", totalPaise: billed, paidOnlinePaise: n.paidOnlinePaise, paidOfflinePaise: n.paidOfflinePaise, refundPaise: n.refundPaise, commissionPaise: n.commissionPaise, documentId: doc.id } }, tx);
    await tell(tx, n, patient, "order.completed", { documentId: doc.id });
    return { order: n, refundIds };
  });
  await submitRefunds(result.refundIds);
  const u = result.order;
  await notifyPatient(u, NOTIFICATION_TYPES.HEALTH_RX_COMPLETED, "Medicines order completed", `Order ${u.orderNumber} from ${shop.name} is complete (${inr(u.totalPaise)}). The bill is saved in your health record.${u.refundPaise > 0 ? ` ${inr(u.refundPaise)} is being refunded for medicines not supplied.` : ""}`);
  return u;
}

/**
 * Brings the store's payout lines for an order up to date (under the order's lock): + the online money
 * kept, − GoKesari's commission (rule health.rxCommissionBp, fixed on the order) on everything kept —
 * online and cash at handover. Repeated calls write only differences, each with its own key.
 */
export async function settleRxOrder(client: DbClient, order: HealthRxOrder, now: Date = new Date()): Promise<HealthRxOrder> {
  if (order.status !== "COMPLETED") return order;
  const onlineKept = Math.max(0, order.paidOnlinePaise - order.refundPaise);
  const kept = onlineKept + order.paidOfflinePaise;
  const targetCommission = Math.round((kept * Math.max(0, order.commissionBp)) / 10_000);
  const existing = await client
    .select({ key: financialAdjustments.idempotencyKey, amount: financialAdjustments.amountPaise })
    .from(financialAdjustments)
    .where(like(financialAdjustments.idempotencyKey, `healthrx:${order.id}:%`));
  const credits = existing.filter((e) => e.key.includes(":credit:"));
  const commissions = existing.filter((e) => e.key.includes(":commission:"));
  const credited = credits.reduce((n, e) => n + e.amount, 0);
  const commissioned = -commissions.reduce((n, e) => n + e.amount, 0);
  const rows: (typeof financialAdjustments.$inferInsert)[] = [];
  if (onlineKept !== credited) {
    rows.push({
      type: "SHOP_ADJUSTMENT",
      party: "SHOP",
      shopId: order.shopId,
      amountPaise: onlineKept - credited,
      reason: `Medicines order ${order.orderNumber}: ${onlineKept - credited >= 0 ? "paid online" : "correction after refund"}`,
      idempotencyKey: `healthrx:${order.id}:credit:${credits.length}`,
    });
  }
  if (targetCommission !== commissioned) {
    rows.push({
      type: "SHOP_ADJUSTMENT",
      party: "SHOP",
      shopId: order.shopId,
      amountPaise: -(targetCommission - commissioned),
      reason: `GoKesari commission ${(order.commissionBp / 100).toFixed(2)}% on medicines order ${order.orderNumber}`,
      idempotencyKey: `healthrx:${order.id}:commission:${commissions.length}`,
    });
  }
  if (rows.length) await client.insert(financialAdjustments).values(rows).onConflictDoNothing();
  const [u] = await client
    .update(healthRxOrders)
    .set({ commissionPaise: targetCommission, settledAt: rows.length || !order.settledAt ? now : order.settledAt, updatedAt: now })
    .where(eq(healthRxOrders.id, order.id))
    .returning();
  if (rows.length) await recordAudit({ action: AUDIT_ACTIONS.HEALTH_RX_ORDER, entityType: "health_rx_order", entityId: order.id, newValue: { event: "settled", onlineKept, cash: order.paidOfflinePaise, commissionPaise: targetCommission, rows: rows.map((r) => ({ key: r.idempotencyKey, amountPaise: r.amountPaise })) } }, client);
  return u;
}

/* ------------------------------------------------------------ cancel */

async function cancelOrder(orderId: string, by: "PATIENT" | "STORE", reason: string | null, actor: HealthActor, now: Date): Promise<HealthRxOrder> {
  const result = await db.transaction(async (tx) => {
    const o = await lockOrder(tx, orderId);
    const allowed = by === "PATIENT" ? PATIENT_CANCELLABLE : STORE_CANCELLABLE;
    if (!allowed.includes(o.status as RxOrderStatus)) {
      throw conflict(by === "PATIENT" ? "The store has already packed this order, so it cannot be cancelled here. Use 'Report a problem'." : o.status === "SENT" ? "Decline a new request instead." : "This order cannot be cancelled now.");
    }
    let [u] = await tx
      .update(healthRxOrders)
      .set({ status: "CANCELLED", cancelledAt: now, cancelReason: `${by === "PATIENT" ? "Customer" : "Store"}: ${(reason ?? "").trim() || "no reason given"}`.slice(0, 500), paymentStatus: o.paymentStatus === "PENDING" || o.paymentStatus === "DUE_ON_HANDOVER" || o.paymentStatus === "FAILED" ? "NOT_DUE" : o.paymentStatus, updatedAt: now })
      .where(eq(healthRxOrders.id, o.id))
      .returning();
    await cancelExpiryNotice(tx, o.id, now);
    const kept = u.paidOnlinePaise - u.refundPaise;
    const refundIds: string[] = [];
    if (kept > 0) {
      const r = await refundRxMoney(tx, u, kept, `${o.orderNumber}: cancelled by the ${by === "PATIENT" ? "customer" : "store"}`, "cancel");
      refundIds.push(...r.refundIds);
      [u] = await tx.update(healthRxOrders).set({ paymentStatus: "REFUNDED" }).where(eq(healthRxOrders.id, o.id)).returning();
    }
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_RX_ORDER, entityType: "health_rx_order", entityId: o.id, previousValue: { status: o.status }, newValue: { event: "cancelled", by, refundPaise: kept > 0 ? kept : 0 } }, tx);
    const patient = await patientOf(u, tx);
    await timeline(tx, u, await shopName(u.shopId, tx));
    await tell(tx, u, patient, "rx.cancelled", { by });
    return { order: u, refundIds, refunded: kept > 0 ? kept : 0, wasSent: o.status === "SENT" };
  });
  await submitRefunds(result.refundIds);
  const u = result.order;
  const name = await shopName(u.shopId);
  if (by === "PATIENT") {
    await notifyStore(u, NOTIFICATION_TYPES.HEALTH_RX_REQUEST, `Order ${u.orderNumber} cancelled by the customer`, `The customer cancelled ${u.orderNumber}${result.wasSent ? " before you replied" : ""}. Nothing more to do.`);
  } else {
    await notifyPatient(u, NOTIFICATION_TYPES.HEALTH_RX_DECLINED, `${name} cancelled your order`, `${name} cancelled ${u.orderNumber}: ${(reason ?? "").trim().slice(0, 200)}.${result.refunded > 0 ? ` ${inr(result.refunded)} is being refunded to the way you paid.` : ""} Send the prescription to another store from My Health.`);
  }
  return u;
}

export async function cancelRxOrder(orderId: string, reason: string | null, actor: HealthActor, now: Date = new Date()): Promise<HealthRxOrder> {
  await requirePatientOrder(orderId, actor);
  return cancelOrder(orderId, "PATIENT", reason, actor, now);
}

export async function storeCancelRxOrder(orderId: string, reason: string | null, actor: HealthActor, now: Date = new Date()): Promise<HealthRxOrder> {
  if ((reason ?? "").trim().length < 5) throw validationFailed("Tell the customer why you are cancelling (at least 5 characters).");
  await requireStoreOrder(orderId, actor);
  return cancelOrder(orderId, "STORE", reason, actor, now);
}

/* ------------------------------------------------------------ report a problem */

export const problemInput = z.object({ reason: z.string().trim().min(10, "Describe the problem (at least 10 characters).").max(2000) });

export async function reportRxProblem(orderId: string, raw: unknown, actor: HealthActor): Promise<{ ticketId: string; ticketNumber: string }> {
  const input = problemInput.parse(raw);
  const o = await loadOrder(orderId);
  const [shop] = await db.select().from(shops).where(eq(shops.id, o.shopId));
  const isStore = shop?.ownerId === actor.id;
  if (!isStore) await requirePatientOrder(orderId, actor);
  const subject = `Medicines order ${o.orderNumber}`;
  const [open] = await db
    .select({ id: supportTickets.id, ticketNumber: supportTickets.ticketNumber })
    .from(supportTickets)
    .where(and(eq(supportTickets.requesterId, actor.id), like(supportTickets.subject, `${subject}%`), sql`${supportTickets.status} not in ('RESOLVED', 'CLOSED')`))
    .limit(1);
  if (open) throw conflict(`A ticket is already open for this order (${open.ticketNumber}).`, { ticketId: open.id });
  const { createTicket } = await import("@/server/aftercare/support-tickets");
  // No medicine names in the ticket (operations read it): order number, status and money only.
  const description = `${input.reason}\n\nOrder ${o.orderNumber} (${o.fulfilment === "PICKUP" ? "pickup" : "delivery"}), status ${o.status}. Total ₹${(o.totalPaise / 100).toFixed(2)}; paid online ₹${(o.paidOnlinePaise / 100).toFixed(2)}, at handover ₹${(o.paidOfflinePaise / 100).toFixed(2)}, refunded ₹${(o.refundPaise / 100).toFixed(2)}. Reported by the ${isStore ? "store" : "customer"}.`;
  const ticket = await createTicket({ category: "ORDER", subject: `${subject}: ${isStore ? "store" : "customer"} report`, description, priority: "HIGH", shopId: isStore ? o.shopId : null }, actor);
  if (!isStore) await db.update(supportTickets).set({ shopId: o.shopId }).where(eq(supportTickets.id, ticket.id));
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_RX_ORDER, entityType: "health_rx_order", entityId: o.id, newValue: { event: "problem_reported", ticketNumber: ticket.ticketNumber, by: isStore ? "STORE" : "PATIENT" } });
  return { ticketId: ticket.id, ticketNumber: ticket.ticketNumber };
}

/* ------------------------------------------------------------ views */

export interface RxOrderCard {
  id: string;
  orderNumber: string;
  status: string;
  statusLabel: string;
  fulfilment: string;
  shopId: string;
  shopName: string;
  patientName: string;
  rxNumber: string;
  items: number;
  totalPaise: number;
  paymentMode: string | null;
  paymentStatus: string;
  createdAt: Date;
  expiresAt: Date;
  pickupAt: Date | null;
  distanceKm: number | null;
}

async function cards(where: ReturnType<typeof and>, limit = 200): Promise<RxOrderCard[]> {
  const rows = await db
    .select({
      o: healthRxOrders,
      shopName: shops.name,
      patientName: healthPatients.fullName,
      rxNumber: healthPrescriptions.rxNumber,
      items: sql<number>`(select count(*)::int from health.rx_order_items i where i.rx_order_id = ${healthRxOrders.id})`,
    })
    .from(healthRxOrders)
    .innerJoin(shops, eq(shops.id, healthRxOrders.shopId))
    .innerJoin(healthPatients, eq(healthPatients.id, healthRxOrders.patientId))
    .innerJoin(healthPrescriptions, eq(healthPrescriptions.id, healthRxOrders.prescriptionId))
    .where(where)
    .orderBy(desc(healthRxOrders.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.o.id,
    orderNumber: r.o.orderNumber,
    status: r.o.status,
    statusLabel: RX_ORDER_STATUS_LABELS[r.o.status as RxOrderStatus] ?? r.o.status,
    fulfilment: r.o.fulfilment,
    shopId: r.o.shopId,
    shopName: r.shopName,
    patientName: r.patientName,
    rxNumber: r.rxNumber,
    items: r.items,
    totalPaise: r.o.totalPaise,
    paymentMode: r.o.paymentMode,
    paymentStatus: r.o.paymentStatus,
    createdAt: r.o.createdAt,
    expiresAt: r.o.expiresAt,
    pickupAt: r.o.pickupAt,
    distanceKm: r.o.distanceKm,
  }));
}

/** The patient side: orders for every record the user manages or is linked to. */
export async function myRxOrders(actor: HealthActor, patientId?: string | null): Promise<RxOrderCard[]> {
  const patients = (await patientsForUser(actor.id)).filter((p) => !patientId || p.id === patientId);
  if (!patients.length) return [];
  return cards(and(inArray(healthRxOrders.patientId, patients.map((p) => p.id))));
}

/** The store's inbox (owner only). */
export async function storeRxInbox(shopId: string, actor: HealthActor): Promise<RxOrderCard[]> {
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId));
  if (!shop || (shop.ownerId !== actor.id && !isHealthStaff(actor))) throw notFound("Store");
  return cards(and(eq(healthRxOrders.shopId, shopId)), 300);
}

export interface RxOrderLineView {
  id: string;
  prescriptionItemId: string;
  name: string;
  genericName: string;
  strength: string | null;
  form: string;
  dose: string;
  frequency: string;
  durationDays: number;
  instructions: string | null;
  prescribedQty: number;
  alreadyDispensed: number;
  allowedOnline: boolean;
  requestedQty: number;
  availability: string | null;
  quotedQty: number;
  substituteName: string | null;
  substituteGeneric: string | null;
  substituteStrength: string | null;
  substituteApproved: boolean | null;
  unitPricePaise: number;
  discountPaise: number;
  lineTotalPaise: number;
  batchNumber: string | null;
  expiryDate: string | null;
  dispensedQty: number;
}

export interface RxOrderDetail {
  viewer: "PATIENT" | "STORE";
  order: Omit<HealthRxOrder, "otpSalt"> & { statusLabel: string; secondsLeft: number };
  lines: RxOrderLineView[];
  store: { id: string; name: string; address: string; phone: string | null; latitude: number | null; longitude: number | null; cashOnHandover: boolean; ownDelivery: boolean; drugLicence: string | null; pharmacist: string | null };
  patient: { id: string; name: string; age: string | null; gender: string | null };
  prescription: { id: string; rxNumber: string; version: number; status: string; issuedAt: Date; validUntil: string | null; doctor: string; registration: string; council: string; clinic: string } | null;
  /** Store only: what to check before quoting. */
  checks: { doctorVerified: boolean; qrValid: boolean; qrStatus: string; withinValidity: boolean; itemsAllowedOnline: boolean; notes: string[] } | null;
  /** Patient only: the pickup / delivery code once the order is ready or on the way. */
  code: string | null;
  otpTriesLeft: number;
  refund: { requestedPaise: number; settledPaise: number; status: "NONE" | "PENDING" | "DONE" | "FAILED" };
  billDocumentId: string | null;
  can: Record<"quote" | "decline" | "pack" | "ready" | "dispatch" | "complete" | "storeCancel" | "approve" | "pay" | "cancel" | "newCode" | "report" | "sendElsewhere", boolean>;
}

export async function rxOrderDetail(orderId: string, actor: HealthActor, ip?: string | null, now: Date = new Date()): Promise<RxOrderDetail> {
  let order = await loadOrder(orderId);
  const [shop] = await db.select().from(shops).where(eq(shops.id, order.shopId));
  let viewer: "PATIENT" | "STORE";
  let patient: HealthPatient;
  if (shop && shop.ownerId === actor.id) {
    viewer = "STORE";
    patient = await patientOf(order);
  } else {
    patient = (await requirePatientOrder(orderId, actor)).patient;
    viewer = "PATIENT";
  }
  // The reply window ended and the timed job has not run yet: close it now, so both sides see the same.
  if (order.status === "SENT" && order.expiresAt.getTime() <= now.getTime()) {
    const expired = await db.transaction(async (tx) => expireInTx(tx, await lockOrder(tx, orderId), now));
    if (expired) {
      order = expired;
      await afterExpiry(expired);
    }
  }
  const [profile] = await db.select().from(healthPharmacyProfiles).where(eq(healthPharmacyProfiles.shopId, order.shopId));
  const lines = await db.select().from(healthRxOrderItems).where(eq(healthRxOrderItems.rxOrderId, order.id));
  const [rx] = await db.select().from(healthPrescriptions).where(eq(healthPrescriptions.id, order.prescriptionId));
  // A store that let the request expire never sees the prescription; otherwise its look is logged.
  const storeMayRead = viewer === "STORE" && order.status !== "EXPIRED";
  if (storeMayRead) await prescriptionView(order.prescriptionId, actor, ip);
  const showClinical = viewer === "PATIENT" || storeMayRead;
  const rxItems = showClinical && lines.length ? await db.select().from(healthPrescriptionItems).where(inArray(healthPrescriptionItems.id, lines.map((l) => l.prescriptionItemId))) : [];
  const allowance = showClinical ? await orderableItems(rx) : [];
  const content = rx.content as unknown as RxContent;
  const lineViews: RxOrderLineView[] = [];
  if (showClinical) {
    const byLine = [...lines].sort((a, b) => (rxItems.find((i) => i.id === a.prescriptionItemId)?.lineNo ?? 0) - (rxItems.find((i) => i.id === b.prescriptionItemId)?.lineNo ?? 0));
    for (const l of byLine) {
      const it = rxItems.find((i) => i.id === l.prescriptionItemId);
      if (!it) continue;
      lineViews.push({
        id: l.id,
        prescriptionItemId: it.id,
        name: itemName(it),
        genericName: it.genericName,
        strength: it.strength,
        form: it.form,
        dose: it.dose,
        frequency: it.frequency,
        durationDays: it.durationDays,
        instructions: it.instructions,
        prescribedQty: it.quantity,
        alreadyDispensed: it.dispensedQty,
        allowedOnline: !(allowance.find((x) => x.id === it.id)?.restricted ?? false),
        requestedQty: l.requestedQty,
        availability: l.availability,
        quotedQty: l.quotedQty,
        substituteName: l.substituteName,
        substituteGeneric: l.substituteGeneric,
        substituteStrength: l.substituteStrength,
        substituteApproved: l.substituteApproved,
        unitPricePaise: l.unitPricePaise,
        discountPaise: l.discountPaise,
        lineTotalPaise: l.lineTotalPaise,
        batchNumber: l.batchNumber,
        expiryDate: l.expiryDate,
        dispensedQty: l.dispensedQty,
      });
    }
  }
  let checks: RxOrderDetail["checks"] = null;
  if (storeMayRead) {
    const status = await doctorStatus(rx.memberId);
    const qr = await verifyPrescription(rx.verificationToken, null);
    const withinValidity = !rxExpired(rx, now);
    const itemsAllowedOnline = lineViews.every((l) => l.allowedOnline);
    const notes: string[] = [];
    if (!status.verified) notes.push("The doctor's GoKesari verification is not complete — check the registration number with the council.");
    if (!qr.valid) notes.push(qr.status === "SUPERSEDED" ? "The doctor has issued a newer version of this prescription — ask the customer to send the latest one." : "The prescription QR could not be verified.");
    if (!withinValidity) notes.push(`The prescription was valid until ${rx.validUntil}.`);
    if (!itemsAllowedOnline) notes.push("A medicine on this request may not be sold online.");
    checks = { doctorVerified: status.verified, qrValid: qr.valid, qrStatus: qr.status, withinValidity, itemsAllowedOnline, notes };
  }
  const intents = await db.select({ id: paymentIntents.id }).from(paymentIntents).where(and(eq(paymentIntents.purpose, "HEALTH_RX_ORDER"), eq(paymentIntents.referenceId, order.id)));
  const refunds = intents.length ? await db.select({ amount: paymentRefunds.amountPaise, status: paymentRefunds.status }).from(paymentRefunds).where(inArray(paymentRefunds.intentId, intents.map((i) => i.id))) : [];
  const requested = refunds.filter((r) => r.status !== "FAILED").reduce((n, r) => n + r.amount, 0);
  const settled = refunds.filter((r) => r.status === "SUCCESS").reduce((n, r) => n + r.amount, 0);
  const [bill] =
    order.status === "COMPLETED"
      ? await db
          .select({ id: healthDocuments.id })
          .from(healthDocuments)
          .where(and(eq(healthDocuments.patientId, order.patientId), eq(healthDocuments.fileName, `${order.orderNumber}-bill.pdf`), eq(healthDocuments.kind, "BILL")))
          .limit(1)
      : [];
  const st = order.status as RxOrderStatus;
  const quoteOpen = st === "SENT" && order.expiresAt.getTime() > now.getTime();
  const { otpSalt, ...rest } = order;
  const store = viewer === "STORE";
  return {
    viewer,
    order: { ...rest, statusLabel: RX_ORDER_STATUS_LABELS[st] ?? order.status, secondsLeft: st === "SENT" ? Math.max(0, Math.floor((order.expiresAt.getTime() - now.getTime()) / 1000)) : 0 },
    lines: lineViews,
    store: {
      id: order.shopId,
      name: shop?.name ?? "Medical store",
      address: shop ? shopAddress(shop) : "",
      phone: shop?.contactPhone ?? null,
      latitude: shop ? (parseCoordinates(shop.latitude, shop.longitude)?.latitude ?? null) : null,
      longitude: shop ? (parseCoordinates(shop.latitude, shop.longitude)?.longitude ?? null) : null,
      cashOnHandover: profile?.cashOnHandover ?? false,
      ownDelivery: profile?.ownDelivery ?? false,
      drugLicence: profile?.drugLicenceNumber ?? null,
      pharmacist: profile ? `${profile.pharmacistName} (Reg. ${profile.pharmacistRegistrationNumber})` : null,
    },
    patient: { id: patient.id, name: patient.fullName, age: showClinical ? (content.patient.age ?? null) : null, gender: showClinical ? (content.patient.gender ?? null) : null },
    prescription: showClinical
      ? { id: rx.id, rxNumber: rx.rxNumber, version: rx.version, status: rx.status, issuedAt: rx.issuedAt, validUntil: rx.validUntil, doctor: content.doctor.name, registration: content.doctor.registrationNumber, council: content.doctor.council, clinic: content.clinic.name }
      : null,
    checks,
    code: !store && HANDOVER.includes(st) && otpSalt ? rxHandoverCode(order.id, otpSalt) : null,
    otpTriesLeft: Math.max(0, RX_OTP_MAX_ATTEMPTS - order.otpAttempts),
    refund: { requestedPaise: requested, settledPaise: settled, status: !refunds.length ? "NONE" : refunds.some((r) => r.status === "FAILED") ? "FAILED" : refunds.some((r) => r.status === "PENDING") ? "PENDING" : "DONE" },
    billDocumentId: bill?.id ?? null,
    can: {
      quote: store && quoteOpen,
      decline: store && quoteOpen,
      pack: store && TO_PACK.includes(st),
      ready: store && order.fulfilment === "PICKUP" && [...TO_PACK, "PACKED"].includes(st),
      dispatch: store && order.fulfilment === "DELIVERY" && [...TO_PACK, "PACKED"].includes(st),
      complete: store && HANDOVER.includes(st),
      storeCancel: store && STORE_CANCELLABLE.includes(st),
      approve: !store && st === "QUOTED" && order.paymentStatus !== "PAID",
      pay: !store && st === "QUOTED" && order.paymentMode === "ONLINE" && ["PENDING", "FAILED"].includes(order.paymentStatus),
      cancel: !store && PATIENT_CANCELLABLE.includes(st),
      newCode: !store && HANDOVER.includes(st),
      report: !["SENT"].includes(st),
      sendElsewhere: !store && ["EXPIRED", "DECLINED", "CANCELLED"].includes(st) && rx.status === "ISSUED" && !rxExpired(rx, now),
    },
  };
}

/** The bill PDF saved in the patient's record (patient side or the store that issued it). */
export async function rxBillPdf(orderId: string, actor: HealthActor): Promise<{ pdf: Buffer; filename: string }> {
  const order = await loadOrder(orderId);
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, order.shopId));
  if (shop?.ownerId !== actor.id) await requirePatientOrder(orderId, actor);
  if (order.status !== "COMPLETED") throw notFound("Bill");
  const [doc] = await db
    .select()
    .from(healthDocuments)
    .where(and(eq(healthDocuments.patientId, order.patientId), eq(healthDocuments.fileName, `${order.orderNumber}-bill.pdf`), eq(healthDocuments.kind, "BILL")))
    .limit(1);
  if (!doc) throw notFound("Bill");
  return { pdf: decryptBytes(doc.data), filename: doc.fileName };
}

/** The prescription PDF behind an order: the patient side, or the store it was sent to (not after the request expired). Logged. */
export async function rxOrderPrescriptionPdf(orderId: string, actor: HealthActor, ip?: string | null): Promise<{ pdf: Buffer; filename: string }> {
  const order = await loadOrder(orderId);
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, order.shopId));
  if (shop?.ownerId === actor.id) {
    if (order.status === "EXPIRED") throw notFound("Prescription");
  } else await requirePatientOrder(orderId, actor);
  const { prescriptionPdf } = await import("./prescriptions");
  return prescriptionPdf(order.prescriptionId, actor, "DOWNLOAD", ip);
}

/* ------------------------------------------------------------ pharmacy profile and verification */

export const pharmacyProfileInput = z.object({
  drugLicenceNumber: z
    .string()
    .trim()
    .min(3, "Enter the drug licence number (Form 20 / 21).")
    .max(80)
    .regex(/^[A-Za-z0-9/\-., ()]+$/, "Letters, digits and / - . , ( ) only."),
  pharmacistName: z.string().trim().min(3, "Enter the registered pharmacist's name.").max(120),
  pharmacistRegistrationNumber: z
    .string()
    .trim()
    .min(2, "Enter the pharmacist's registration number.")
    .max(40)
    .regex(/^[A-Za-z0-9/\-. ]+$/, "Letters, digits, / - . only."),
  pharmacyCouncil: z.string().trim().max(120).nullish(),
  acceptsPrescriptions: z.boolean().default(true),
  ownDelivery: z.boolean().default(true),
  cashOnHandover: z.boolean().default(true),
  deliveryRadiusKm: z.number().int().min(1).max(50).default(5),
});
export type PharmacyProfileInput = z.input<typeof pharmacyProfileInput>;

async function requirePharmacyOwner(shopId: string, actor: HealthActor, allowStaff = false): Promise<Shop> {
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop || shop.deletedAt) throw notFound("Store");
  if (shop.ownerId !== actor.id && !(allowStaff && isHealthStaff(actor))) throw notFound("Store");
  if (shop.shopType !== "PHARMACY") throw conflict("Only a medical store (shop type Pharmacy) can take prescriptions.");
  return shop;
}

export async function pharmacyProfileOf(shopId: string, actor: HealthActor): Promise<{ shop: { id: string; name: string; status: string }; profile: HealthPharmacyProfile | null }> {
  const shop = await requirePharmacyOwner(shopId, actor, true);
  const [profile] = await db.select().from(healthPharmacyProfiles).where(eq(healthPharmacyProfiles.shopId, shopId));
  return { shop: { id: shop.id, name: shop.name, status: String(shop.status) }, profile: profile ?? null };
}

/** The store owner saves the drug licence, pharmacist and delivery options. A licence / pharmacist change goes back to review. */
export async function savePharmacyProfile(shopId: string, raw: unknown, actor: HealthActor): Promise<HealthPharmacyProfile> {
  const input = pharmacyProfileInput.parse(raw);
  const shop = await requirePharmacyOwner(shopId, actor);
  const now = new Date();
  const [before] = await db.select().from(healthPharmacyProfiles).where(eq(healthPharmacyProfiles.shopId, shopId));
  const identity = { drugLicenceNumber: input.drugLicenceNumber.toUpperCase(), pharmacistName: input.pharmacistName, pharmacistRegistrationNumber: input.pharmacistRegistrationNumber.toUpperCase(), pharmacyCouncil: input.pharmacyCouncil ?? null };
  const changed =
    !before ||
    before.drugLicenceNumber !== identity.drugLicenceNumber ||
    before.pharmacistName !== identity.pharmacistName ||
    before.pharmacistRegistrationNumber !== identity.pharmacistRegistrationNumber ||
    (before.pharmacyCouncil ?? null) !== identity.pharmacyCouncil;
  const values = {
    ...identity,
    acceptsPrescriptions: input.acceptsPrescriptions,
    ownDelivery: input.ownDelivery,
    cashOnHandover: input.cashOnHandover,
    deliveryRadiusKm: input.deliveryRadiusKm,
    updatedAt: now,
    ...(changed ? { verification: "PENDING", verificationNote: null, verifiedBy: null, verifiedAt: null } : {}),
  };
  const [row] = await db
    .insert(healthPharmacyProfiles)
    .values({ shopId, ...values, verification: changed ? "PENDING" : (before?.verification ?? "PENDING") })
    .onConflictDoUpdate({ target: healthPharmacyProfiles.shopId, set: values })
    .returning();
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_RX_ORDER, entityType: "health_pharmacy_profile", entityId: shopId, newValue: { event: "pharmacy_profile_saved", reverify: changed, drugLicenceNumber: identity.drugLicenceNumber, deliveryRadiusKm: input.deliveryRadiusKm } });
  if (changed) await publishHealthEvent({ name: "provider.verification_pending", shopId: shop.id, subjectId: shop.id, payload: { kind: "PHARMACY" } });
  return row;
}

/** Staff (health:manage) verify or reject a medical store's licence and pharmacist. */
export async function verifyPharmacy(shopId: string, decision: "VERIFIED" | "REJECTED", note: string | null, actor: HealthActor): Promise<HealthPharmacyProfile> {
  if (!isHealthStaff(actor)) throw forbidden("Only GoKesari staff can verify medical stores.");
  if (decision !== "VERIFIED" && decision !== "REJECTED") throw validationFailed("Choose verify or reject.");
  if (decision === "REJECTED" && (note ?? "").trim().length < 5) throw validationFailed("Give the reason for rejecting (the store sees it).");
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Store");
  const now = new Date();
  const [row] = await db
    .update(healthPharmacyProfiles)
    .set({ verification: decision, verificationNote: (note ?? "").trim().slice(0, 500) || null, verifiedBy: actor.id, verifiedAt: now, updatedAt: now })
    .where(eq(healthPharmacyProfiles.shopId, shopId))
    .returning();
  if (!row) throw notFound("Pharmacy profile");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HEALTH_PROVIDER_VERIFIED, entityType: "health_pharmacy", entityId: shopId, newValue: { verification: decision, note: row.verificationNote } });
  await publishHealthEvent({ name: decision === "VERIFIED" ? "provider.verified" : "provider.rejected", userIds: [shop.ownerId], shopId, subjectId: shopId, payload: { kind: "PHARMACY", decision } });
  await notify({
    userId: shop.ownerId,
    type: NOTIFICATION_TYPES.HEALTH_VERIFICATION,
    title: decision === "VERIFIED" ? `${shop.name} can now take prescriptions` : `${shop.name}: medical store details need a change`,
    body: decision === "VERIFIED" ? "GoKesari verified your drug licence and pharmacist. Patients nearby can now send you prescriptions." : `GoKesari could not verify your medical store: ${(note ?? "").trim()}. Correct the details and save again.`,
    actionUrl: "/shop/health/pharmacy",
    channels: ["PUSH"],
    metadata: { shopId, decision },
  });
  return row;
}

/** Medical stores waiting for verification (staff screen). */
export async function pendingPharmacies(actor: HealthActor): Promise<{ shopId: string; shopName: string; shopStatus: string; city: string; ownerName: string; drugLicenceNumber: string; pharmacistName: string; pharmacistRegistrationNumber: string; pharmacyCouncil: string | null; submittedAt: Date }[]> {
  if (!isHealthStaff(actor)) throw forbidden("Only GoKesari staff can see this.");
  const rows = await db
    .select({ p: healthPharmacyProfiles, shopName: shops.name, shopStatus: shops.status, city: shops.city, ownerName: shops.ownerName })
    .from(healthPharmacyProfiles)
    .innerJoin(shops, eq(shops.id, healthPharmacyProfiles.shopId))
    .where(and(eq(healthPharmacyProfiles.verification, "PENDING"), isNull(shops.deletedAt)))
    .orderBy(asc(healthPharmacyProfiles.updatedAt));
  return rows.map((r) => ({
    shopId: r.p.shopId,
    shopName: r.shopName,
    shopStatus: String(r.shopStatus),
    city: r.city,
    ownerName: r.ownerName,
    drugLicenceNumber: r.p.drugLicenceNumber,
    pharmacistName: r.p.pharmacistName,
    pharmacistRegistrationNumber: r.p.pharmacistRegistrationNumber,
    pharmacyCouncil: r.p.pharmacyCouncil,
    submittedAt: r.p.updatedAt,
  }));
}
