/**
 * Flow spec v3, F6 shop subscription (docs/flows-v3/wave3.md, flag flow_f6; owner, 27-Nov-2026): "the 1-year
 * subscription starts at go-live". The fee payment still opens the first period (shop-membership.ts
 * settleMembershipAfterPayment, unchanged); when the shop then goes live for the first time, that period is moved to
 * start on the go-live day and end periodMonths later. Shops already live keep their dates (only a first approval
 * moves anything), and so does a shop whose fee was paid after it went live (its period already starts later).
 */
import { and, eq, isNull } from "drizzle-orm";

import type { DbClient } from "@/server/db";
import { shopMembershipPeriods, shops } from "@/server/db/schema";
import { addMonths } from "@/server/services/shop-membership";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";

import { wave3Switch } from "./wave3-rules";

export interface GoLiveAnchor {
  periodId: string;
  periodStart: Date;
  periodEnd: Date;
  validUntil: Date;
}

/** Pure: the first period and the membership end moved so the period starts at go-live. Null when nothing moves. */
export function anchorAtGoLive(
  period: { periodStart: Date; periodEnd: Date },
  validUntil: Date | null,
  goLiveAt: Date,
  periodMonths: number,
): { periodStart: Date; periodEnd: Date; validUntil: Date } | null {
  if (period.periodStart.getTime() >= goLiveAt.getTime()) return null;
  const periodEnd = addMonths(goLiveAt, periodMonths);
  // Time added on top of this period (a referral month, an admin's extension) is kept on top of the new end.
  const extra = validUntil && validUntil.getTime() > period.periodEnd.getTime() ? validUntil.getTime() - period.periodEnd.getTime() : 0;
  return { periodStart: goLiveAt, periodEnd, validUntil: new Date(periodEnd.getTime() + extra) };
}

/**
 * Inside approveShopTransaction (shop row locked), on a shop's first approval: moves its only REGISTRATION period to
 * start at go-live. No-op with flow_f6 off, for a shop approved before, or one with more than that one period.
 */
export async function anchorSubscriptionAtGoLive(
  tx: DbClient,
  shop: { id: string; approvedAt: Date | null },
  goLiveAt: Date,
): Promise<GoLiveAnchor | null> {
  if (shop.approvedAt !== null) return null;
  if (!(await wave3Switch("subscriptionStartsAtGoLive"))) return null;
  const periods = await tx
    .select()
    .from(shopMembershipPeriods)
    .where(and(eq(shopMembershipPeriods.shopId, shop.id), isNull(shopMembershipPeriods.voidedAt)));
  if (periods.length !== 1 || periods[0].kind !== "REGISTRATION") return null;
  const [period] = periods;
  const [row] = await tx.select({ until: shops.membershipValidUntil, start: shops.registrationStartDate }).from(shops).where(eq(shops.id, shop.id));
  const { periodMonths } = await getRule("shopMembership");
  const moved = anchorAtGoLive(period, row?.until ?? null, goLiveAt, periodMonths);
  if (!moved) return null;
  await tx
    .update(shopMembershipPeriods)
    .set({ periodStart: moved.periodStart, periodEnd: moved.periodEnd })
    .where(eq(shopMembershipPeriods.id, period.id));
  await tx
    .update(shops)
    .set({ membershipValidUntil: moved.validUntil, registrationStartDate: moved.periodStart })
    .where(eq(shops.id, shop.id));
  await recordAudit(
    {
      action: AUDIT_ACTIONS.SHOP_MEMBERSHIP_PERIOD_OPENED,
      entityType: "shop",
      entityId: shop.id,
      previousValue: { periodStart: period.periodStart.toISOString(), periodEnd: period.periodEnd.toISOString(), validUntil: row?.until?.toISOString() ?? null, registrationStartDate: row?.start?.toISOString() ?? null },
      newValue: { periodId: period.id, startsAtGoLive: true, periodStart: moved.periodStart.toISOString(), periodEnd: moved.periodEnd.toISOString(), validUntil: moved.validUntil.toISOString() },
    },
    tx,
  );
  return { periodId: period.id, ...moved };
}
