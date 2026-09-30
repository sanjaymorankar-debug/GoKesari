/**
 * Delivery-partner earnings (delivery-system Part 58 follow-up, Slice C).
 *
 * Same "single active config row" pattern as registrationFees, minus a
 * dedicated history table — rate changes here are lower-stakes and don't
 * carry the same legal/billing weight, so recordAudit() is judged
 * sufficient traceability for v1. One earnings row per completed delivery,
 * idempotent on deliveryOrderId so a retried credit never pays out twice.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { conflict, isUniqueViolation, notFound, validationFailed } from "@/lib/errors";
import {
  calculateEarning,
  localTime,
  type EarningBreakdown,
  type EarningOutcome,
  type IncentiveRule,
  type SlotRule,
} from "@/lib/earnings-calc";
import { getEnv } from "@/lib/env";
import { db, type DbClient } from "@/server/db";
import {
  deliveryEarningsConfig,
  deliveryOrders,
  deliveryPartnerEarnings,
  orders,
  riderEarningSlots,
  riderEarningsLedger,
  riderIncentiveAwards,
  riderIncentiveRules,
  type DeliveryEarningsConfig,
  type DeliveryPartnerEarning,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { postRiderEarning } from "./finance";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

const DEFAULT_BASE_FEE_PAISE = 2000;
const DEFAULT_PER_KM_FEE_PAISE = 800;

/** Bootstraps a default config on first read so every caller sees a normal row, not a magic fallback scattered across call sites. */
export async function getActiveEarningsConfig(): Promise<DeliveryEarningsConfig> {
  const active = await db.query.deliveryEarningsConfig.findFirst({
    where: eq(deliveryEarningsConfig.isActive, true),
    orderBy: desc(deliveryEarningsConfig.createdAt),
  });
  if (active) return active;

  const [created] = await db
    .insert(deliveryEarningsConfig)
    .values({
      baseFeePaise: DEFAULT_BASE_FEE_PAISE,
      perKmFeePaise: DEFAULT_PER_KM_FEE_PAISE,
      isActive: true,
      note: "Default (auto-created)",
    })
    .returning();
  return created;
}

export async function setEarningsConfig(
  input: { baseFeePaise: number; perKmFeePaise: number; note?: string },
  actor: Actor,
): Promise<DeliveryEarningsConfig> {
  if (!Number.isFinite(input.baseFeePaise) || input.baseFeePaise < 0) {
    throw validationFailed("Base fee must be a non-negative number.");
  }
  if (!Number.isFinite(input.perKmFeePaise) || input.perKmFeePaise < 0) {
    throw validationFailed("Per-km fee must be a non-negative number.");
  }

  return db.transaction(async (tx) => {
    const previous = await tx.query.deliveryEarningsConfig.findFirst({
      where: eq(deliveryEarningsConfig.isActive, true),
    });
    if (previous) {
      await tx
        .update(deliveryEarningsConfig)
        .set({ isActive: false })
        .where(eq(deliveryEarningsConfig.id, previous.id));
    }

    const [created] = await tx
      .insert(deliveryEarningsConfig)
      .values({
        baseFeePaise: input.baseFeePaise,
        perKmFeePaise: input.perKmFeePaise,
        isActive: true,
        note: input.note?.trim() || null,
        createdBy: actor.id,
      })
      .returning();

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DELIVERY_EARNINGS_CONFIG_CHANGED,
        entityType: "delivery_earnings_config",
        entityId: created.id,
        previousValue: previous
          ? { baseFeePaise: previous.baseFeePaise, perKmFeePaise: previous.perKmFeePaise }
          : null,
        newValue: { baseFeePaise: created.baseFeePaise, perKmFeePaise: created.perKmFeePaise },
      },
      tx,
    );

    return created;
  });
}

/** Active slot and incentive rules in the shapes the calculator takes. */
export async function loadEarningRules(client: DbClient = db): Promise<{
  slots: SlotRule[];
  incentives: IncentiveRule[];
}> {
  const [slotRows, incentiveRows] = await Promise.all([
    client.select().from(riderEarningSlots).where(eq(riderEarningSlots.isActive, true)),
    client.select().from(riderIncentiveRules).where(eq(riderIncentiveRules.isActive, true)),
  ]);
  return {
    slots: slotRows.map((r) => ({ ...r })),
    incentives: incentiveRows.map((r) => ({ ...r })),
  };
}

/**
 * What one delivery earns, without writing anything — the same calculation
 * creditDeliveryEarnings persists. `counts` say how many deliveries the rider
 * has completed today/this week INCLUDING this one (used by count incentives).
 */
export async function previewEarning(input: {
  outcome?: EarningOutcome;
  distanceKm: number;
  orderSubtotalPaise: number;
  at: Date;
  dayCount?: number;
  weekCount?: number;
  minutesLate?: number | null;
}): Promise<EarningBreakdown> {
  const [config, rules, { slots, incentives }] = await Promise.all([
    getActiveEarningsConfig(),
    getRule("riderEarnings"),
    loadEarningRules(),
  ]);
  return calculateEarning(config, slots, incentives, rules, {
    outcome: input.outcome ?? "DELIVERED",
    distanceKm: input.distanceKm,
    orderSubtotalPaise: input.orderSubtotalPaise,
    at: input.at,
    timeZone: getEnv().APP_TIMEZONE,
    dayCount: input.dayCount ?? 1,
    weekCount: input.weekCount ?? 1,
    minutesLate: input.minutesLate ?? null,
    alreadyAwarded: new Set(),
    deliveryOrderId: "preview",
  });
}

/**
 * Idempotent on deliveryOrderId — a retried credit (e.g. a re-run failsafe)
 * never pays out twice. Eligible once a delivery is DELIVERED, or — per D10
 * (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md DEF-08) — CANCELLED after
 * the rider had already picked it up: the customer cancelled a dispatched
 * order, but the rider still did the pickup-and-transit work and is still
 * paid for it. `client` composes this into a caller's own transaction (e.g.
 * cancelOrder's DEF-08 fix); omit it for the original standalone behaviour.
 *
 * The amount comes from the configurable engine (lib/earnings-calc.ts): the
 * slot matching the completion time supplies the rates, incentives are added
 * for completed drops, deductions applied, and each component is written both
 * on the earning row and as append-only lines in rider_earnings_ledger.
 */
export async function creditDeliveryEarnings(
  deliveryOrderId: string,
  client?: DbClient,
): Promise<DeliveryPartnerEarning> {
  const c = client ?? db;
  const existing = await c.query.deliveryPartnerEarnings.findFirst({
    where: eq(deliveryPartnerEarnings.deliveryOrderId, deliveryOrderId),
  });
  if (existing) return existing;

  const deliveryOrder = await c.query.deliveryOrders.findFirst({
    where: eq(deliveryOrders.id, deliveryOrderId),
  });
  if (!deliveryOrder) throw notFound("Delivery assignment");
  // FAILED (Slice 4): the rider collected the order and attempted the drop,
  // so the trip is paid like a cancelled-after-pickup one.
  const eligible =
    deliveryOrder.status === "DELIVERED" ||
    deliveryOrder.status === "FAILED" ||
    (deliveryOrder.status === "CANCELLED" && deliveryOrder.pickedUpAt != null);
  if (!eligible) {
    throw conflict(
      "Earnings can only be credited once a delivery is marked delivered, or cancelled after the rider picked it up.",
    );
  }

  const outcome: EarningOutcome =
    deliveryOrder.status === "DELIVERED" ? "DELIVERED" : deliveryOrder.status === "FAILED" ? "FAILED" : "CANCELLED_AFTER_PICKUP";
  const at =
    (outcome === "DELIVERED" ? deliveryOrder.deliveredAt : outcome === "FAILED" ? deliveryOrder.failedAt : deliveryOrder.cancelledAt) ??
    deliveryOrder.acceptedAt ??
    deliveryOrder.offeredAt;
  const timeZone = getEnv().APP_TIMEZONE;
  const t = localTime(at, timeZone);

  const [order] = await c
    .select({ subtotalPaise: orders.subtotalPaise, promisedByAt: orders.promisedByAt })
    .from(orders)
    .where(eq(orders.id, deliveryOrder.orderId));
  const config = await getActiveEarningsConfig();
  const rules = await getRule("riderEarnings");
  const { slots, incentives } = await loadEarningRules(c);

  // Completed drops by this rider in the local day / ISO week of `at`, this one included.
  const countIn = async (bucket: "day" | "week") => {
    const [row] = await c
      .select({ n: sql<number>`count(*)::int` })
      .from(deliveryOrders)
      .where(
        and(
          eq(deliveryOrders.deliveryPartnerId, deliveryOrder.deliveryPartnerId),
          eq(deliveryOrders.status, "DELIVERED"),
          bucket === "day"
            ? sql`(${deliveryOrders.deliveredAt} AT TIME ZONE ${timeZone})::date = ${t.dateKey}::date`
            : sql`to_char(${deliveryOrders.deliveredAt} AT TIME ZONE ${timeZone}, 'IYYY-"W"IW') = ${t.weekKey}`,
        ),
      );
    return row?.n ?? 0;
  };
  const [dayCount, weekCount] = outcome === "DELIVERED" ? await Promise.all([countIn("day"), countIn("week")]) : [0, 0];

  const awardedRows = await c
    .select({ ruleId: riderIncentiveAwards.ruleId, periodKey: riderIncentiveAwards.periodKey })
    .from(riderIncentiveAwards)
    .where(
      and(
        eq(riderIncentiveAwards.deliveryPartnerId, deliveryOrder.deliveryPartnerId),
        inArray(riderIncentiveAwards.periodKey, [t.dateKey, t.weekKey]),
      ),
    );

  const breakdown = calculateEarning(config, slots, incentives, rules, {
    outcome,
    distanceKm: deliveryOrder.distanceKm ? Number(deliveryOrder.distanceKm) : 0,
    orderSubtotalPaise: order?.subtotalPaise ?? 0,
    at,
    timeZone,
    dayCount,
    weekCount,
    minutesLate:
      order?.promisedByAt && deliveryOrder.deliveredAt
        ? (deliveryOrder.deliveredAt.getTime() - order.promisedByAt.getTime()) / 60_000
        : null,
    alreadyAwarded: new Set(awardedRows.map((r) => `${r.ruleId}:${r.periodKey}`)),
    deliveryOrderId,
  });

  try {
    const [earning] = await c
      .insert(deliveryPartnerEarnings)
      .values({
        deliveryPartnerId: deliveryOrder.deliveryPartnerId,
        deliveryOrderId,
        basePaise: breakdown.basePaise,
        distancePaise: breakdown.distancePaise,
        orderComponentPaise: breakdown.orderComponentPaise,
        slotIncentivePaise: breakdown.slotIncentivePaise,
        minTopUpPaise: breakdown.minTopUpPaise,
        orderIncentivePaise: breakdown.orderIncentivePaise,
        otherIncentivePaise: breakdown.otherIncentivePaise,
        deductionsPaise: breakdown.deductionsPaise,
        slotId: breakdown.slotId,
        totalPaise: breakdown.totalPaise,
      })
      .returning();

    if (breakdown.lines.length > 0) {
      await c.insert(riderEarningsLedger).values(
        breakdown.lines.map((line) => ({
          deliveryPartnerId: deliveryOrder.deliveryPartnerId,
          earningId: earning.id,
          deliveryOrderId,
          component: line.component,
          amountPaise: line.amountPaise,
          description: line.description,
        })),
      );
    }
    if (breakdown.awards.length > 0) {
      await c
        .insert(riderIncentiveAwards)
        .values(
          breakdown.awards.map((a) => ({
            ruleId: a.ruleId,
            deliveryPartnerId: deliveryOrder.deliveryPartnerId,
            earningId: earning.id,
            periodKey: a.periodKey,
            amountPaise: a.amountPaise,
          })),
        )
        .onConflictDoNothing();
    }
    // Slice 6: journal the earning (rider credit / platform cost), same transaction.
    await postRiderEarning(earning, deliveryOrder.orderId, c);
    return earning;
  } catch (error) {
    if (isUniqueViolation(error)) {
      const row = await c.query.deliveryPartnerEarnings.findFirst({
        where: eq(deliveryPartnerEarnings.deliveryOrderId, deliveryOrderId),
      });
      if (row) return row;
    }
    throw error;
  }
}

/**
 * Flat fee for a completed return pickup (rule `returns.riderPickupFeePaise`,
 * default: the base fee). Idempotent per pickup; journaled like any earning.
 */
export async function creditReturnPickupEarning(
  returnPickupId: string,
  deliveryPartnerId: string,
  orderId: string,
  client: DbClient = db,
): Promise<DeliveryPartnerEarning> {
  const existing = await client.query.deliveryPartnerEarnings.findFirst({
    where: eq(deliveryPartnerEarnings.returnPickupId, returnPickupId),
  });
  if (existing) return existing;

  const returns = await getRule("returns");
  const fee = returns.riderPickupFeePaise ?? (await getActiveEarningsConfig()).baseFeePaise;
  const [earning] = await client
    .insert(deliveryPartnerEarnings)
    .values({ deliveryPartnerId, returnPickupId, basePaise: fee, distancePaise: 0, totalPaise: fee })
    .onConflictDoNothing()
    .returning();
  if (!earning) {
    const row = await client.query.deliveryPartnerEarnings.findFirst({
      where: eq(deliveryPartnerEarnings.returnPickupId, returnPickupId),
    });
    if (row) return row;
    throw conflict("Could not record the return pickup earning.");
  }
  if (fee > 0) {
    await client.insert(riderEarningsLedger).values({
      deliveryPartnerId,
      earningId: earning.id,
      component: "BASE",
      amountPaise: fee,
      description: "Return pickup fee",
    });
  }
  await postRiderEarning(earning, orderId, client);
  return earning;
}

/** The audit lines behind one earning, oldest first. */
export async function listEarningLines(earningIds: readonly string[]) {
  if (earningIds.length === 0) return [];
  return db
    .select()
    .from(riderEarningsLedger)
    .where(inArray(riderEarningsLedger.earningId, [...earningIds]))
    .orderBy(riderEarningsLedger.createdAt);
}

export async function getPartnerEarningsSummary(
  partnerId: string,
): Promise<{ todayPaise: number; totalPaise: number; deliveryCount: number }> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const rows = await db
    .select()
    .from(deliveryPartnerEarnings)
    .where(eq(deliveryPartnerEarnings.deliveryPartnerId, partnerId));

  let todayPaise = 0;
  let totalPaise = 0;
  for (const row of rows) {
    totalPaise += row.totalPaise;
    if (row.createdAt >= startOfToday) todayPaise += row.totalPaise;
  }
  return { todayPaise, totalPaise, deliveryCount: rows.length };
}

export async function listPartnerEarnings(
  partnerId: string,
  limit = 50,
): Promise<DeliveryPartnerEarning[]> {
  return db
    .select()
    .from(deliveryPartnerEarnings)
    .where(eq(deliveryPartnerEarnings.deliveryPartnerId, partnerId))
    .orderBy(desc(deliveryPartnerEarnings.createdAt))
    .limit(limit);
}
