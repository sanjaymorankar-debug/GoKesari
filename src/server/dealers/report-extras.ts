/**
 * Dealer report e-mails, additions (owner, 27-Nov-2026):
 *   - the Monday weekly report lists the shops (by name) registered under the dealer last week;
 *   - a month-end report on the LAST day of the month (20:00 IST) with this month's shops and commission;
 *   - a super franchisee (0226) also gets his team: each team dealer's shops and commission, and his own share.
 * Shops come from shop_attributions, so every dealer model is covered (not only TIERED networks):
 *   "live" = paid and approved (activated) in the period; "started" = registered with his code in the period, not live yet.
 */
import { and, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

import { addDays, todayIn } from "@/lib/dates";
import { db } from "@/server/db";
import { dealerCommissionLedger, dealers, shopAttributions, shops, superFranchiseeMembers, superFranchisees } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { getFeatureFlag } from "@/server/services/feature-flags";
import { notify } from "@/server/services/notifications";

const ZONE = "Asia/Kolkata";
const OFFSET = "+05:30";
/** Month-end report: from this IST hour on the last day of the month. */
export const MONTH_END_HOUR_IST = 20;
/** At most this many shop lines in one e-mail; the rest are counted. */
const MAX_SHOP_LINES = 40;

export interface DetailLine {
  label: string;
  value: string;
}

export interface PeriodShop {
  dealerId: string;
  name: string;
  city: string | null;
  state: "LIVE" | "STARTED";
  at: Date;
}

const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: ZONE }).replace(/ /g, "-");

/** Shops of these dealers that went live, or were started and are not live yet, in [from, to). */
export async function shopsInPeriod(dealerIds: string[], from: Date, to: Date): Promise<PeriodShop[]> {
  if (!dealerIds.length) return [];
  const rows = await db
    .select({ dealerId: shopAttributions.dealerId, name: shops.name, city: shops.city, createdAt: shopAttributions.createdAt, activatedAt: shopAttributions.activatedAt })
    .from(shopAttributions)
    .innerJoin(shops, eq(shops.id, shopAttributions.shopId))
    .where(
      and(
        inArray(shopAttributions.dealerId, dealerIds),
        eq(shopAttributions.status, "ACTIVE"),
        or(and(gte(shopAttributions.activatedAt, from), lt(shopAttributions.activatedAt, to)), and(gte(shopAttributions.createdAt, from), lt(shopAttributions.createdAt, to))),
      ),
    );
  return rows
    .map((r) => {
      const live = !!r.activatedAt && r.activatedAt >= from && r.activatedAt < to;
      return { dealerId: r.dealerId, name: r.name, city: r.city, state: live ? ("LIVE" as const) : ("STARTED" as const), at: live ? r.activatedAt! : r.createdAt };
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Commission earned by a dealer in [from, to), less reversals; by entry type group. */
export async function commissionInPeriod(dealerId: string, from: Date, to: Date): Promise<{ totalPaise: number; superPaise: number }> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}), 0)::bigint`,
      sup: sql<number>`coalesce(sum(${dealerCommissionLedger.amountPaise}) filter (where ${dealerCommissionLedger.entryType} in ('SUPER_FEE', 'SUPER_ORDER')), 0)::bigint`,
    })
    .from(dealerCommissionLedger)
    .where(and(eq(dealerCommissionLedger.dealerId, dealerId), ne(dealerCommissionLedger.status, "REVERSED"), gte(dealerCommissionLedger.createdAt, from), lt(dealerCommissionLedger.createdAt, to)));
  return { totalPaise: Number(row?.total ?? 0), superPaise: Number(row?.sup ?? 0) };
}

/** "Shop: Sharma Kirana, Pune — live 24-Nov" lines, live shops first. */
export function shopLines(list: PeriodShop[], who?: Map<string, string>): DetailLine[] {
  const ordered = [...list.filter((s) => s.state === "LIVE"), ...list.filter((s) => s.state === "STARTED")];
  const lines = ordered.slice(0, MAX_SHOP_LINES).map((s) => ({
    label: `Shop${who ? ` (${who.get(s.dealerId) ?? "team"})` : ""}`,
    value: `${s.name}${s.city ? `, ${s.city}` : ""} — ${s.state === "LIVE" ? `live ${day(s.at)}` : `registration started ${day(s.at)}`}`,
  }));
  if (ordered.length > MAX_SHOP_LINES) lines.push({ label: "More shops", value: `${ordered.length - MAX_SHOP_LINES} more on your dealer page` });
  return lines;
}

/** The team of a super franchisee (dealers whose link is open now), or [] when he is not one. */
export async function superTeam(superDealerId: string): Promise<{ id: string; name: string }[]> {
  const [sf] = await db.select({ status: superFranchisees.status }).from(superFranchisees).where(eq(superFranchisees.dealerId, superDealerId));
  if (sf?.status !== "ACTIVE") return [];
  return db
    .select({ id: dealers.id, name: dealers.legalName })
    .from(superFranchiseeMembers)
    .innerJoin(dealers, eq(dealers.id, superFranchiseeMembers.memberDealerId))
    .where(and(eq(superFranchiseeMembers.superDealerId, superDealerId), isNull(superFranchiseeMembers.endsAt)))
    .orderBy(dealers.legalName);
}

/**
 * A super franchisee's team for [from, to): one line per team dealer (shops live / started, commission), his own
 * share, and the team's shops by name. `active` = anything happened.
 */
export async function superTeamLines(superDealerId: string, from: Date, to: Date): Promise<{ lines: DetailLine[]; active: boolean; teamSize: number }> {
  const team = await superTeam(superDealerId);
  if (!team.length) return { lines: [], active: false, teamSize: 0 };
  const list = await shopsInPeriod(
    team.map((t) => t.id),
    from,
    to,
  );
  const lines: DetailLine[] = [];
  let active = list.length > 0;
  for (const t of team) {
    const mine = list.filter((s) => s.dealerId === t.id);
    const { totalPaise } = await commissionInPeriod(t.id, from, to);
    if (totalPaise !== 0) active = true;
    lines.push({ label: `Team: ${t.name}`, value: `${mine.filter((s) => s.state === "LIVE").length} shops live, ${mine.filter((s) => s.state === "STARTED").length} started, ${inr(totalPaise)} commission` });
  }
  const { superPaise } = await commissionInPeriod(superDealerId, from, to);
  if (superPaise !== 0) active = true;
  lines.push({ label: "Your super franchisee share", value: inr(superPaise) });
  lines.push(...shopLines(list, new Map(team.map((t) => [t.id, t.name]))));
  return { lines, active, teamSize: team.length };
}

/* ======================================================= month-end report */

/** True from MONTH_END_HOUR_IST on the last day of the month (IST). */
export function isMonthEndWindow(now: Date = new Date()): boolean {
  const today = todayIn(ZONE, now);
  if (!addDays(today, 1).endsWith("-01")) return false;
  const hour = Number(now.toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: ZONE }).slice(0, 2));
  return hour >= MONTH_END_HOUR_IST;
}

/**
 * The month-end report (owner, 27-Nov-2026): on the last day of the month from 20:00 IST, to every approved dealer
 * with a sign-in — this month's shops by name (live / started), the commission earned this month, and for a super
 * franchisee his team. Sent even when the month was quiet, once per dealer and month. The statement and payout on
 * the 5th stay as they are. Run every 15 minutes; a no-op outside the window or while the dealer programme is off.
 */
export async function sendMonthEndReports(now: Date = new Date()): Promise<{ sent: number } | { skipped: string }> {
  if (!isMonthEndWindow(now)) return { skipped: "not the month-end window" };
  if (!(await getFeatureFlag("dealer_programme_enabled")).enabled) return { skipped: "dealer programme off" };
  const today = todayIn(ZONE, now);
  const month = today.slice(0, 7);
  const from = new Date(`${month}-01T00:00:00${OFFSET}`);
  const to = now;
  const monthLabel = from.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: ZONE });
  const list = await db.select().from(dealers).where(and(eq(dealers.status, "APPROVED"), eq(dealers.isInternal, false)));
  let sent = 0;
  for (const dealer of list) {
    if (!dealer.userId) continue;
    const own = await shopsInPeriod([dealer.id], from, to);
    const { totalPaise } = await commissionInPeriod(dealer.id, from, to);
    const team = await superTeamLines(dealer.id, from, to);
    const live = own.filter((s) => s.state === "LIVE").length;
    const started = own.filter((s) => s.state === "STARTED").length;
    const detail: DetailLine[] = [{ label: "This month", value: `${live} shops live, ${started} registrations started, ${inr(totalPaise)} commission earned` }, ...shopLines(own), ...team.lines];
    await notify({
      userId: dealer.userId,
      type: NOTIFICATION_TYPES.DEALER_TEAM_REPORT,
      vars: { period: "Month-end", label: `${monthLabel} — ${dealer.legalName}`, started, registered: live, commission: inr(totalPaise) },
      actionUrl: "/dealer#team-performance",
      channels: ["EMAIL"],
      emailDetail: detail,
      dedupeKey: `dealer-month-end-report:${month}:${dealer.id}:${dealer.userId}`,
    });
    sent += 1;
  }
  return { sent };
}
