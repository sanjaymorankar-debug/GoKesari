/**
 * Delivery-partner earnings (delivery-system Part 58 follow-up, Slice C).
 *
 * Same "single active config row" pattern as registrationFees, minus a
 * dedicated history table — rate changes here are lower-stakes and don't
 * carry the same legal/billing weight, so recordAudit() is judged
 * sufficient traceability for v1. One earnings row per completed delivery,
 * idempotent on deliveryOrderId so a retried credit never pays out twice.
 */
import { desc, eq } from "drizzle-orm";

import { conflict, isUniqueViolation, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  deliveryEarningsConfig,
  deliveryOrders,
  deliveryPartnerEarnings,
  type DeliveryEarningsConfig,
  type DeliveryPartnerEarning,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { postRiderEarning } from "./finance";

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

/**
 * Idempotent on deliveryOrderId — a retried credit (e.g. a re-run failsafe)
 * never pays out twice. Eligible once a delivery is DELIVERED, or — per D10
 * (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md DEF-08) — CANCELLED after
 * the rider had already picked it up: the customer cancelled a dispatched
 * order, but the rider still did the pickup-and-transit work and is still
 * paid for it. `client` composes this into a caller's own transaction (e.g.
 * cancelOrder's DEF-08 fix); omit it for the original standalone behaviour.
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

  const config = await getActiveEarningsConfig();
  const distanceKm = deliveryOrder.distanceKm ? Number(deliveryOrder.distanceKm) : 0;
  const distancePaise = Math.round((Number.isFinite(distanceKm) ? distanceKm : 0) * config.perKmFeePaise);
  const totalPaise = config.baseFeePaise + distancePaise;

  try {
    const [earning] = await c
      .insert(deliveryPartnerEarnings)
      .values({
        deliveryPartnerId: deliveryOrder.deliveryPartnerId,
        deliveryOrderId,
        basePaise: config.baseFeePaise,
        distancePaise,
        totalPaise,
      })
      .returning();
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
