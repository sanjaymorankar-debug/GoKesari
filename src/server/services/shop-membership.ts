/**
 * Shop membership (D-69, owner 25 Oct 2026): "if they have not renewed the
 * membership they can be marked as not online".
 *
 * A registration fee or renewal payment extends shops.membership_valid_until
 * by rule shopMembership.periodMonths. Once that date is more than graceDays
 * behind, the shop is closed to customers the same way as a shop that paused
 * its orders (serviceability.ts walletOrderGate / withWalletGate) until a
 * renewal is recorded. A shop with no end date is never affected.
 */
import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";

import { db, type DbClient } from "@/server/db";
import { shops, type Shop } from "@/server/db/schema";
import { getRule } from "./settings";

const DAY_MS = 86_400_000;

/** `date` plus whole calendar months (the 31st becomes the month's last day). */
export function addMonths(date: Date, months: number): Date {
  const out = new Date(date);
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

/** The new end after a payment on `paidAt`: from the current end while it lasts, else from the payment. */
export function membershipEndAfterPayment(current: Date | null, paidAt: Date, periodMonths: number): Date {
  return addMonths(current && current > paidAt ? current : paidAt, periodMonths);
}

/** Called with a registration fee or renewal payment, in the same transaction (the shop row is locked by the caller). */
export async function extendMembership(tx: DbClient, shopId: string, paidAt: Date): Promise<Date> {
  const rule = await getRule("shopMembership");
  const [shop] = await tx.select({ until: shops.membershipValidUntil }).from(shops).where(eq(shops.id, shopId));
  const until = membershipEndAfterPayment(shop?.until ?? null, paidAt, rule.periodMonths);
  await tx.update(shops).set({ membershipValidUntil: until, updatedAt: new Date() }).where(eq(shops.id, shopId));
  return until;
}

export type MembershipState = "NONE" | "ACTIVE" | "DUE_SOON" | "GRACE" | "LAPSED";

export interface MembershipStatus {
  state: MembershipState;
  validUntil: Date | null;
  /** When the shop stops (or stopped) being online: the end plus the grace days. */
  offlineFrom: Date | null;
}

export function membershipStatus(
  shop: Pick<Shop, "membershipValidUntil">,
  rule: { enabled: boolean; graceDays: number; reminderDays: number },
  now = new Date(),
): MembershipStatus {
  const until = shop.membershipValidUntil;
  if (!until) return { state: "NONE", validUntil: null, offlineFrom: null };
  const offlineFrom = new Date(until.getTime() + rule.graceDays * DAY_MS);
  let state: MembershipState = "ACTIVE";
  if (now >= until) state = rule.enabled && now >= offlineFrom ? "LAPSED" : "GRACE";
  else if (until.getTime() - now.getTime() <= rule.reminderDays * DAY_MS) state = "DUE_SOON";
  return { state, validUntil: until, offlineFrom };
}

/** SQL on the outer `shops` row: true while the membership keeps the shop online. */
export async function membershipOrderGate(): Promise<SQL> {
  const rule = await getRule("shopMembership");
  if (!rule.enabled) return sql`true`;
  // Raw names, as in walletOrderGate: the condition sits in queries over `shops`.
  return sql`(shops.membership_valid_until is null or shops.membership_valid_until > now() - make_interval(days => ${rule.graceDays}))`;
}

/** The shops among `shopIds` that are not online because their membership lapsed. */
export async function membershipLapsedShopIds(shopIds: string[]): Promise<Set<string>> {
  if (shopIds.length === 0) return new Set();
  const rule = await getRule("shopMembership");
  if (!rule.enabled) return new Set();
  const rows = await db
    .select({ id: shops.id })
    .from(shops)
    .where(
      and(
        inArray(shops.id, shopIds),
        isNotNull(shops.membershipValidUntil),
        sql`${shops.membershipValidUntil} <= now() - make_interval(days => ${rule.graceDays})`,
      ),
    );
  return new Set(rows.map((r) => r.id));
}
