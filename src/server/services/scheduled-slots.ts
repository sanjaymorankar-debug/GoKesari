/**
 * GS-027: the customer chooses a date and a time slot for a scheduled
 * delivery (rule scheduledSlots; slot limits from the deliverySlots rule and
 * Admin → Delivery slots).
 *
 * listScheduledSlots() offers only slots that are in the future, start after
 * the cut-off (and the shop's preparation time), fall inside the shop's
 * opening hours (IST; a shop with no hours uses the rule's default day), and
 * still have a place under both the per-slot and the per-day limit.
 * reserveScheduledSlot() repeats those checks inside the order's transaction
 * under the shop's scheduled-day lock — the same lock every scheduled booking
 * takes — so two customers cannot both take the last place.
 */
import { eq } from "drizzle-orm";

import { addDays, todayIn, type IsoDate } from "@/lib/dates";
import { conflict, validationFailed } from "@/lib/errors";
import { formatScheduledSlot, istMidnightMs, parseScheduledSlotKey, scheduledSlotKey } from "@/lib/scheduled-slots";
import { db, type DbClient } from "@/server/db";
import { shops, type Shop } from "@/server/db/schema";
import { lockScheduledDay, scheduledBookings, scheduledLimitsFor } from "./delivery-slots";
import { getRule } from "./settings";

const TIME_ZONE = "Asia/Kolkata";
const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export interface ScheduledSlot {
  key: string;
  date: IsoDate;
  start: string;
  end: string;
  label: string;
  /** Places left (the smaller of slot and day); null = no limit. */
  remaining: number | null;
}

export interface ScheduledSlotOptions {
  enabled: boolean;
  slots: ScheduledSlot[];
}

type ShopHours = Pick<Shop, "openingHours" | "preparationTimeMinutes" | "deliveryAvailable">;
type Rule = Awaited<ReturnType<typeof getRule<"scheduledSlots">>>;

/** Every slot of `date` the shop's hours allow, ignoring time and capacity. */
function slotsOfDay(shop: ShopHours, date: IsoDate, rule: Rule): { key: string; start: Date; end: Date }[] {
  const weekday = new Date(istMidnightMs(date) + 330 * 60_000).getUTCDay();
  let open = toMinutes(rule.defaultOpen);
  let close = toMinutes(rule.defaultClose);
  if (shop.openingHours.length > 0) {
    const entry = shop.openingHours.find((h) => h.day === weekday);
    if (!entry || entry.closed) return [];
    open = toMinutes(entry.open);
    close = toMinutes(entry.close);
  }
  const out: { key: string; start: Date; end: Date }[] = [];
  for (let t = open; t + rule.slotMinutes <= close; t += rule.slotMinutes) {
    const start = new Date(istMidnightMs(date) + t * 60_000);
    out.push({ key: scheduledSlotKey(date, t), start, end: new Date(start.getTime() + rule.slotMinutes * 60_000) });
  }
  return out;
}

function earliestStart(shop: ShopHours, rule: Rule, now: Date): number {
  return now.getTime() + Math.max(rule.cutoffMinutes, shop.preparationTimeMinutes) * 60_000;
}

function remainingFor(
  key: string,
  date: string,
  limits: { perDay: number | null; perSlot: number | null } | null,
  booked: Map<string, number>,
): number | null {
  if (!limits) return null;
  const inSlot = booked.get(key) ?? 0;
  const inDay = [...booked.entries()].filter(([k]) => k === date || k.startsWith(`${date}@`)).reduce((n, [, c]) => n + c, 0);
  const left = [limits.perSlot == null ? null : limits.perSlot - inSlot, limits.perDay == null ? null : limits.perDay - inDay].filter(
    (v): v is number => v != null,
  );
  return left.length ? Math.min(...left) : null;
}

/** Slots a customer may choose now for a delivery from `shopId`. */
export async function listScheduledSlots(shopId: string, now: Date = new Date(), client: DbClient = db): Promise<ScheduledSlotOptions> {
  const rule = await getRule("scheduledSlots");
  if (!rule.enabled) return { enabled: false, slots: [] };
  const shop = await client.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop || !shop.deliveryAvailable) return { enabled: true, slots: [] };

  const today = todayIn(TIME_ZONE, now);
  const days = Array.from({ length: rule.daysAhead }, (_, i) => addDays(today, i));
  const limits = await scheduledLimitsFor(shopId, client);
  const booked = limits ? await scheduledBookings(shopId, days, client) : new Map<string, number>();
  const earliest = earliestStart(shop, rule, now);

  const slots: ScheduledSlot[] = [];
  for (const date of days) {
    for (const slot of slotsOfDay(shop, date, rule)) {
      if (slot.start.getTime() < earliest) continue;
      const remaining = remainingFor(slot.key, date, limits, booked);
      if (remaining != null && remaining <= 0) continue;
      slots.push({
        key: slot.key,
        date,
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
        label: formatScheduledSlot(slot.start, slot.end),
        remaining,
      });
    }
  }
  return { enabled: true, slots };
}

/**
 * Books the chosen slot inside the order's transaction. Throws a validation
 * error for a slot that is not on offer (past, after hours, inside the
 * cut-off) and a conflict when it filled up since the customer looked.
 */
export async function reserveScheduledSlot(
  tx: DbClient,
  shopId: string,
  key: string,
  now: Date = new Date(),
): Promise<{ slotKey: string; start: Date; end: Date; date: IsoDate }> {
  const rule = await getRule("scheduledSlots");
  if (!rule.enabled) throw validationFailed("Choosing a delivery time is not available right now.");
  const parsed = parseScheduledSlotKey(key);
  if (!parsed) throw validationFailed("That delivery slot is not valid.");
  const [shop] = await tx.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) throw validationFailed("That delivery slot is not valid.");

  const today = todayIn(TIME_ZONE, now);
  const lastDay = addDays(today, rule.daysAhead - 1);
  const slot = slotsOfDay(shop, parsed.date, rule).find((s) => s.key === key);
  if (!slot || parsed.date < today || parsed.date > lastDay) {
    throw validationFailed("That delivery slot is not offered by this shop. Please choose another time.");
  }
  if (slot.start.getTime() < earliestStart(shop, rule, now)) {
    throw validationFailed("That delivery slot is too soon now. Please choose a later time.");
  }

  const limits = await scheduledLimitsFor(shopId, tx);
  if (limits) {
    await lockScheduledDay(tx, shopId, parsed.date);
    const booked = await scheduledBookings(shopId, [parsed.date], tx);
    const remaining = remainingFor(key, parsed.date, limits, booked);
    if (remaining != null && remaining <= 0) {
      throw conflict(`The ${formatScheduledSlot(slot.start, slot.end)} slot at ${shop.name} has just filled up. Please choose another time.`);
    }
  }
  return { slotKey: key, start: slot.start, end: slot.end, date: parsed.date };
}

/** GS-027: a rider is sought for a time-slot order only from this moment. */
export async function scheduledDispatchFrom(order: { scheduledSlotStart: Date | null }): Promise<Date | null> {
  if (!order.scheduledSlotStart) return null;
  const rule = await getRule("scheduledSlots");
  return new Date(order.scheduledSlotStart.getTime() - rule.dispatchLeadMinutes * 60_000);
}
