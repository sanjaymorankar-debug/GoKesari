/**
 * Delivery slot capacity (feature F5).
 *
 * A slot is one shop's delivery window in one period: an IST hour for express
 * and standard delivery ("2026-10-05T14"), an IST day for scheduled delivery
 * ("2026-10-05"). Each slot takes at most N orders — the shop's own limit,
 * else its area's (PIN code), else the platform default (rule
 * "deliverySlots"); a null limit is unlimited. With the rule off nothing is
 * limited and orders carry no slot key, exactly as before.
 *
 * Overbooking is prevented in reserveSlot(): inside the order's own
 * transaction it takes a per-slot advisory lock and counts the slot's live
 * orders, so two customers booking the last place at once are serialised and
 * the second one is moved to another window (or refused). Cancelled and
 * failed orders free their place automatically, since they stop counting.
 */
import { and, eq, notInArray, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import { deliverySlotCapacities, orders, shops, type DeliveryWindow, type OrderStatus } from "@/server/db/schema";
import { getRule } from "./settings";

const TIME_ZONE = "Asia/Kolkata";

/** Orders in these statuses no longer hold a place in their slot. */
export const SLOT_RELEASING_STATUSES: OrderStatus[] = [
  "CANCELLED",
  "PAYMENT_FAILED",
  "WALLET_INSUFFICIENT",
  "REFUND_PENDING",
  "REFUNDED",
  "FAILED",
];

const parts = (at: Date) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;

/** The slot an order placed at `at` for `window` falls into. */
export function slotKeyFor(window: DeliveryWindow, at: Date = new Date()): string {
  const p = parts(at);
  const day = `${p.year}-${p.month}-${p.day}`;
  return window === "SCHEDULED" ? day : `${day}T${p.hour}`;
}

type Limits = Record<DeliveryWindow, number | null>;

async function limitsFor(shopId: string, client: DbClient = db): Promise<Limits | null> {
  const rule = await getRule("deliverySlots");
  if (!rule.enabled) return null;
  const [shop] = await client.select({ id: shops.id, pincode: shops.pincode }).from(shops).where(eq(shops.id, shopId));
  if (!shop) return null;
  const rows = await client
    .select()
    .from(deliverySlotCapacities)
    .where(
      shop.pincode
        ? sql`${deliverySlotCapacities.shopId} = ${shopId} OR ${deliverySlotCapacities.pincode} = ${shop.pincode}`
        : eq(deliverySlotCapacities.shopId, shopId),
    );
  const own = rows.find((r) => r.shopId === shopId);
  const area = rows.find((r) => r.pincode != null);
  const pick = (k: "expressPerHour" | "standardPerHour" | "scheduledPerDay", fallback: number | null) =>
    own?.[k] ?? area?.[k] ?? fallback;
  return {
    EXPRESS_30: pick("expressPerHour", rule.defaultExpressPerHour),
    STANDARD_60: pick("standardPerHour", rule.defaultStandardPerHour),
    SCHEDULED: pick("scheduledPerDay", rule.defaultScheduledPerDay),
  };
}

async function bookedIn(shopId: string, window: DeliveryWindow, slotKey: string, client: DbClient): Promise<number> {
  const [row] = await client
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.shopId, shopId),
        eq(orders.deliveryWindow, window),
        eq(orders.deliverySlotKey, slotKey),
        notInArray(orders.status, SLOT_RELEASING_STATUSES),
      ),
    );
  return row?.n ?? 0;
}

export interface SlotAvailability {
  enabled: boolean;
  slots: Record<DeliveryWindow, { slotKey: string; capacity: number | null; booked: number; full: boolean }>;
}

/** Current slot of each window for a shop, and whether it is full. */
export async function getSlotAvailability(shopId: string, at: Date = new Date()): Promise<SlotAvailability> {
  const limits = await limitsFor(shopId);
  const windows: DeliveryWindow[] = ["EXPRESS_30", "STANDARD_60", "SCHEDULED"];
  const slots = {} as SlotAvailability["slots"];
  for (const w of windows) {
    const slotKey = slotKeyFor(w, at);
    const capacity = limits ? limits[w] : null;
    const booked = capacity == null ? 0 : await bookedIn(shopId, w, slotKey, db);
    slots[w] = { slotKey, capacity, booked, full: capacity != null && booked >= capacity };
  }
  return { enabled: limits != null, slots };
}

/**
 * Books a place for an order in `window`'s current slot, inside the caller's
 * transaction. Returns the slot key ("" when capacity is off — store null),
 * or null when the slot is full. The advisory lock is held until the
 * transaction ends, so the order insert that follows is counted by the next
 * booker.
 */
export async function reserveSlot(
  tx: DbClient,
  shopId: string,
  window: DeliveryWindow,
  at: Date = new Date(),
): Promise<{ slotKey: string | null } | null> {
  const limits = await limitsFor(shopId, tx);
  if (!limits) return { slotKey: null };
  const slotKey = slotKeyFor(window, at);
  const capacity = limits[window];
  if (capacity == null) return { slotKey };
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`slot:${shopId}:${window}:${slotKey}`}, 0))`);
  const booked = await bookedIn(shopId, window, slotKey, tx);
  return booked < capacity ? { slotKey } : null;
}

/* ---------------------------------------------------------------- admin */

export interface CapacityInput {
  shopId?: string | null;
  pincode?: string | null;
  expressPerHour: number | null;
  standardPerHour: number | null;
  scheduledPerDay: number | null;
}

export async function listSlotCapacities() {
  return db
    .select({
      id: deliverySlotCapacities.id,
      shopId: deliverySlotCapacities.shopId,
      shopName: shops.name,
      pincode: deliverySlotCapacities.pincode,
      expressPerHour: deliverySlotCapacities.expressPerHour,
      standardPerHour: deliverySlotCapacities.standardPerHour,
      scheduledPerDay: deliverySlotCapacities.scheduledPerDay,
      updatedAt: deliverySlotCapacities.updatedAt,
    })
    .from(deliverySlotCapacities)
    .leftJoin(shops, eq(shops.id, deliverySlotCapacities.shopId))
    .orderBy(deliverySlotCapacities.updatedAt);
}

/** Creates or replaces the limits for one shop or one PIN code. */
export async function upsertSlotCapacity(input: CapacityInput, actorId: string) {
  const shopId = input.shopId || null;
  const pincode = input.pincode?.trim() || null;
  if ((shopId == null) === (pincode == null)) throw validationFailed("Set limits for either one shop or one PIN code.");
  if (pincode && !/^\d{6}$/.test(pincode)) throw validationFailed("Enter a 6-digit PIN code.");
  for (const v of [input.expressPerHour, input.standardPerHour, input.scheduledPerDay]) {
    if (v != null && (!Number.isInteger(v) || v < 0)) throw validationFailed("Limits must be whole numbers, 0 or more.");
  }
  if (shopId) {
    const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
    if (!shop) throw notFound("Shop");
  }
  const values = {
    shopId,
    pincode,
    expressPerHour: input.expressPerHour,
    standardPerHour: input.standardPerHour,
    scheduledPerDay: input.scheduledPerDay,
    updatedBy: actorId,
    updatedAt: new Date(),
  };
  const existing = await db
    .select({ id: deliverySlotCapacities.id })
    .from(deliverySlotCapacities)
    .where(shopId ? eq(deliverySlotCapacities.shopId, shopId) : eq(deliverySlotCapacities.pincode, pincode!));
  if (existing[0]) {
    const [row] = await db.update(deliverySlotCapacities).set(values).where(eq(deliverySlotCapacities.id, existing[0].id)).returning();
    return row;
  }
  const [row] = await db.insert(deliverySlotCapacities).values(values).returning();
  return row;
}

export async function deleteSlotCapacity(id: string) {
  const deleted = await db.delete(deliverySlotCapacities).where(eq(deliverySlotCapacities.id, id)).returning();
  if (deleted.length === 0) throw notFound("Slot limit");
}

export const slotFullError = (shopName: string) =>
  conflict(`Every delivery slot at ${shopName} is full right now. Please try again a little later.`);
