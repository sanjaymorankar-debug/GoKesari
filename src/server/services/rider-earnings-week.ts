/**
 * Rider App v2 — the rider's earnings week (Mon–Sun, IST).
 *
 * GET /api/delivery-partner/earnings/week?start=YYYY-MM-DD and the page
 * /delivery-partner/earnings read this. The week maths is pure
 * (src/lib/rider-week.ts). Cash collected on COD orders and not yet deposited
 * is reported apart as `cashInHand` — it is never netted into earnings here.
 *
 * Privacy: only the rider's own pay lines, order numbers and the cash they
 * hold — no customer, order-value, delivery-fee or commission fields
 * (tests/unit/rider-privacy.test.ts).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { localTime } from "@/lib/earnings-calc";
import { summariseWeek, weekWindow, type LedgerComponent, type WeekSummary, type WeekWindow } from "@/lib/rider-week";
import { db } from "@/server/db";
import { deliveryOrders, deliveryPartnerEarnings, financialAdjustments, orders, riderPayouts } from "@/server/db/schema";
import { listEarningLines } from "./delivery-earnings";

export { weekWindow, summariseWeek } from "@/lib/rider-week";

export interface RiderPayoutLine {
  id: string;
  periodStart: string;
  periodEnd: string;
  amountPaise: number;
  status: string;
  /** Bank reference (UTR) once paid. */
  utr: string | null;
  deliveries: number;
}

export interface RiderEarningsWeek extends WeekSummary {
  week: WeekWindow;
  /** COD cash the rider collected and has not deposited yet — shown apart, never netted into earnings. */
  cashInHand: { heldPaise: number; orders: number };
  /** The rider's latest weekly payouts with their UTR. */
  payouts: RiderPayoutLine[];
}

/**
 * COD cash held by one rider: the same sum as listCodCashHeld (services/cod.ts)
 * — pending COD_CASH_COLLECTED (−) and COD_CASH_DEPOSITED (+) adjustments —
 * for this rider only.
 */
export async function riderCashInHand(deliveryPartnerId: string): Promise<{ heldPaise: number; orders: number }> {
  const [row] = await db
    .select({
      net: sql<number>`coalesce(sum(${financialAdjustments.amountPaise}), 0)::bigint`,
      orders: sql<number>`count(*) filter (where ${financialAdjustments.type} = 'COD_CASH_COLLECTED')::int`,
    })
    .from(financialAdjustments)
    .where(
      and(
        eq(financialAdjustments.deliveryPartnerId, deliveryPartnerId),
        eq(financialAdjustments.party, "RIDER"),
        inArray(financialAdjustments.type, ["COD_CASH_COLLECTED", "COD_CASH_DEPOSITED"]),
        eq(financialAdjustments.status, "PENDING"),
      ),
    );
  const held = -Number(row?.net ?? 0);
  return { heldPaise: held > 0 ? held : 0, orders: held > 0 ? (row?.orders ?? 0) : 0 };
}

export async function getRiderEarningsWeek(
  deliveryPartnerId: string,
  requestedStart: string | null | undefined,
  now: Date = new Date(),
): Promise<RiderEarningsWeek> {
  const timeZone = getEnv().APP_TIMEZONE;
  const week = weekWindow(requestedStart, localTime(now, timeZone).dateKey);
  const dateKey = sql<string>`to_char(${deliveryPartnerEarnings.createdAt} AT TIME ZONE ${timeZone}, 'YYYY-MM-DD')`;

  const rows = await db
    .select({
      earning: deliveryPartnerEarnings,
      dateKey,
      orderNumber: orders.orderNumber,
      payoutStatus: riderPayouts.status,
    })
    .from(deliveryPartnerEarnings)
    .leftJoin(deliveryOrders, eq(deliveryPartnerEarnings.deliveryOrderId, deliveryOrders.id))
    .leftJoin(orders, eq(deliveryOrders.orderId, orders.id))
    .leftJoin(riderPayouts, eq(deliveryPartnerEarnings.payoutId, riderPayouts.id))
    .where(
      and(
        eq(deliveryPartnerEarnings.deliveryPartnerId, deliveryPartnerId),
        sql`(${deliveryPartnerEarnings.createdAt} AT TIME ZONE ${timeZone})::date BETWEEN ${week.start}::date AND ${week.end}::date`,
      ),
    )
    .orderBy(desc(deliveryPartnerEarnings.createdAt))
    .limit(1000);

  const ledger = await listEarningLines(rows.map((r) => r.earning.id));
  const summary = summariseWeek(
    week,
    rows.map(({ earning: e, dateKey: key, orderNumber, payoutStatus }) => ({
      id: e.id,
      dateKey: key,
      createdAt: e.createdAt,
      orderNumber: orderNumber ?? null,
      isReturnPickup: e.deliveryOrderId == null,
      basePaise: Number(e.basePaise),
      distancePaise: Number(e.distancePaise),
      orderComponentPaise: Number(e.orderComponentPaise),
      slotIncentivePaise: Number(e.slotIncentivePaise),
      minTopUpPaise: Number(e.minTopUpPaise),
      orderIncentivePaise: Number(e.orderIncentivePaise),
      otherIncentivePaise: Number(e.otherIncentivePaise),
      deductionsPaise: Number(e.deductionsPaise),
      totalPaise: Number(e.totalPaise),
      quotePaise: e.quotePaise ?? null,
      payoutStatus: payoutStatus ?? null,
    })),
    ledger.map((l) => ({
      earningId: l.earningId,
      component: l.component as LedgerComponent,
      amountPaise: Number(l.amountPaise),
      description: l.description,
    })),
  );

  const [cashInHand, payoutRows] = await Promise.all([
    riderCashInHand(deliveryPartnerId),
    db
      .select()
      .from(riderPayouts)
      .where(eq(riderPayouts.deliveryPartnerId, deliveryPartnerId))
      .orderBy(desc(riderPayouts.createdAt))
      .limit(6),
  ]);

  return {
    ...summary,
    week,
    cashInHand,
    payouts: payoutRows.map((p) => ({
      id: p.id,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      amountPaise: Number(p.amountPaise),
      status: p.status,
      utr: p.paymentReference ?? null,
      deliveries: p.earningsCount,
    })),
  };
}
