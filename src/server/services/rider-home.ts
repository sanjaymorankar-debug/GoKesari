/**
 * Rider App v2 Home (rule riderAppV2): the high-earning-slot banner, the daily /
 * weekly incentive ladder and the important messages for one rider.
 *
 * Read-only and best-effort: each part returns null / [] on its own when there
 * is nothing to show. Times are IST (APP_TIMEZONE).
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { inWindow, localTime, pickSlot, type LocalTime, type SlotRule } from "@/lib/earnings-calc";
import { parseCoordinates } from "@/lib/geo/haversine";
import { db } from "@/server/db";
import { deliveryOrders, deliveryPartners, riderEarningSlots, riderIncentiveRules, type DeliveryPartner } from "@/server/db/schema";
import { NOTIFICATION_TYPES, listNotifications } from "./notifications";
import { liveSurges } from "./rider-pay-plans";

/* ------------------------------------------------------------ banner */

export interface SurgeBannerItem {
  label: string;
  /** "HH:MM" IST. */
  from: string;
  to: string;
  /** Extra percent on the trip pay (multiplier − 100%), 0 when none. */
  extraPct: number;
  /** Flat extra per order. */
  flatPaise: number;
}

const hhmm = (d: Date, timeZone: string) => {
  const t = localTime(d, timeZone);
  return `${String(Math.floor(t.minutes / 60)).padStart(2, "0")}:${String(t.minutes % 60).padStart(2, "0")}`;
};

/** The peak slot and manual surges live now for the rider's area (their last position / city). */
export async function liveHighEarning(
  partner: Pick<DeliveryPartner, "lastLocationLatitude" | "lastLocationLongitude" | "addressCity">,
  now: Date = new Date(),
): Promise<SurgeBannerItem[]> {
  const timeZone = getEnv().APP_TIMEZONE;
  const items: SurgeBannerItem[] = [];
  const slots = await db.select().from(riderEarningSlots).where(eq(riderEarningSlots.isActive, true));
  const slot = pickSlot(slots as unknown as SlotRule[], now, timeZone) as unknown as (typeof slots)[number] | null;
  if (slot && ((slot.surgeMultiplierBp ?? 10000) > 10000 || Number(slot.peakBonusPaise) > 0)) {
    items.push({
      label: slot.name,
      from: slot.startTime,
      to: slot.endTime,
      extraPct: Math.max(0, Math.round(((slot.surgeMultiplierBp ?? 10000) - 10000) / 100)),
      flatPaise: Number(slot.peakBonusPaise),
    });
  }
  const surges = await liveSurges(
    { city: partner.addressCity ?? null, point: parseCoordinates(partner.lastLocationLatitude, partner.lastLocationLongitude) },
    now,
  );
  for (const s of surges) {
    if (s.multiplierBp <= 10000 && s.flatPaise <= 0) continue;
    items.push({
      label: s.note?.trim() || s.reason,
      from: hhmm(s.startsAt, timeZone),
      to: hhmm(s.endsAt, timeZone),
      extraPct: Math.max(0, Math.round((s.multiplierBp - 10000) / 100)),
      flatPaise: s.flatPaise,
    });
  }
  return items;
}

/* ------------------------------------------------------------ ladder */

export interface LadderStep {
  id: string;
  name: string;
  /** Trips needed. */
  target: number;
  rewardPaise: number;
  unlocked: boolean;
}

export interface IncentiveLadder {
  period: "DAY" | "WEEK";
  trips: number;
  steps: LadderStep[];
  /** The first step still locked, or null when all are earned. */
  next: LadderStep | null;
}

function ruleActiveOn(rule: { daysOfWeek: number[]; validFrom: string | null; validTo: string | null; startTime: string | null; endTime: string | null }, t: LocalTime, checkWindow: boolean): boolean {
  if (rule.daysOfWeek.length > 0 && !rule.daysOfWeek.includes(t.weekday)) return false;
  if (rule.validFrom && t.dateKey < rule.validFrom) return false;
  if (rule.validTo && t.dateKey > rule.validTo) return false;
  return !checkWindow || inWindow(t.minutes, rule.startTime, rule.endTime);
}

/** Active DAILY_TARGET / WEEKLY_TARGET rules against this rider's delivered trips today / this ISO week (IST). */
export async function incentiveLadders(deliveryPartnerId: string, now: Date = new Date()): Promise<IncentiveLadder[]> {
  const timeZone = getEnv().APP_TIMEZONE;
  const t = localTime(now, timeZone);
  const rules = (
    await db
      .select()
      .from(riderIncentiveRules)
      .where(and(eq(riderIncentiveRules.isActive, true), inArray(riderIncentiveRules.type, ["DAILY_TARGET", "WEEKLY_TARGET"])))
  ).filter((r) => ruleActiveOn(r, t, false));
  if (rules.length === 0) return [];

  const [counts] = await db
    .select({
      day: sql<number>`count(*) filter (where (${deliveryOrders.deliveredAt} AT TIME ZONE ${timeZone})::date = ${t.dateKey}::date)::int`,
      week: sql<number>`count(*) filter (where to_char(${deliveryOrders.deliveredAt} AT TIME ZONE ${timeZone}, 'IYYY-"W"IW') = ${t.weekKey})::int`,
    })
    .from(deliveryOrders)
    .where(
      and(
        eq(deliveryOrders.deliveryPartnerId, deliveryPartnerId),
        eq(deliveryOrders.status, "DELIVERED"),
        sql`${deliveryOrders.deliveredAt} > now() - interval '8 days'`,
      ),
    );

  const ladders: IncentiveLadder[] = [];
  for (const period of ["DAY", "WEEK"] as const) {
    const type = period === "DAY" ? "DAILY_TARGET" : "WEEKLY_TARGET";
    const trips = period === "DAY" ? (counts?.day ?? 0) : (counts?.week ?? 0);
    const steps = rules
      .filter((r) => r.type === type)
      .sort((a, b) => a.thresholdValue - b.thresholdValue)
      .map((r) => ({ id: r.id, name: r.name, target: r.thresholdValue, rewardPaise: Number(r.rewardPaise), unlocked: trips >= r.thresholdValue }));
    if (steps.length === 0) continue;
    ladders.push({ period, trips, steps, next: steps.find((s) => !s.unlocked) ?? null });
  }
  return ladders;
}

/* ------------------------------------------------------------ messages */

export interface RiderMessage {
  id: string;
  title: string;
  body: string;
  actionUrl: string | null;
  createdAt: string;
  unread: boolean;
}

/** Admin broadcasts (Admin → Broadcasts) that reached this rider's in-app inbox, newest first. */
export async function riderMessages(userId: string, limit = 3): Promise<RiderMessage[]> {
  const rows = await listNotifications(userId, { limit: 50 });
  return rows
    .filter((n) => n.type === NOTIFICATION_TYPES.BROADCAST)
    .slice(0, limit)
    .map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      actionUrl: n.actionUrl,
      createdAt: n.createdAt.toISOString(),
      unread: n.readAt == null,
    }));
}

/** Everything the v2 Home shows below the job card, each part on its own (a failure shows nothing for that part). */
export async function getRiderHome(partnerId: string, userId: string, now: Date = new Date()) {
  const partner = await db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.id, partnerId) });
  const [banner, ladders, messages] = await Promise.all([
    partner ? liveHighEarning(partner, now).catch(() => []) : Promise.resolve([]),
    incentiveLadders(partnerId, now).catch(() => []),
    riderMessages(userId).catch(() => []),
  ]);
  return { banner, ladders, messages };
}
