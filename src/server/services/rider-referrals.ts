/**
 * Rider Refer & Earn (Rider App v2, rule riderReferral — OFF by default).
 *
 *  - Every APPROVED rider gets a code ("GKR" + 6 characters) on delivery_partners.referral_code
 *    the first time they open Refer & Earn while the rule is on.
 *  - A new rider may give a code (or arrive through /delivery-partner/register?ref=CODE) when
 *    registering: the referral row snapshots the rule's terms, so a later change never moves the
 *    goalposts. Self-referral is refused (and the table's CHECK forbids it).
 *  - checkReferralQualification(referredPartnerId) — called after each delivery credit — counts the
 *    referred rider's DELIVERED deliveries inside the window (approval → + withinDays). On reaching
 *    deliveriesRequired: QUALIFIED, reward paid as a RIDER_ADJUSTMENT (finance.recordAdjustment,
 *    idempotent by key, flows into the next weekly payout) and the referrer is notified. Past the
 *    window: EXPIRED. Idempotent; safe to call any number of times.
 */
import { and, count, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import { conflict, isUniqueViolation, validationFailed } from "@/lib/errors";
import { formatPaiseCompact } from "@/lib/money";
import { newReferralCode, normaliseReferralCode, referralState } from "@/lib/rider-growth";
import { db } from "@/server/db";
import { auditLogs, deliveryOrders, deliveryPartners, riderReferrals, type RiderReferral } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { recordAdjustment } from "./finance";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { getRule } from "./settings";

/** Drizzle wraps the driver's error: look at both. */
const uniqueViolation = (error: unknown) => isUniqueViolation(error) || isUniqueViolation((error as { cause?: unknown } | null)?.cause);

/** The reward is paid by the system, not by a person: no user id on the adjustment / audit row. */
const SYSTEM_ACTOR = { id: null, role: null } as unknown as Parameters<typeof recordAdjustment>[1];

export async function referralRule() {
  return getRule("riderReferral");
}

/* ------------------------------------------------------------------- codes */

/** The rider's code, created on first use. Null while the rule is off or the rider is not APPROVED. */
export async function ensureReferralCode(partnerId: string): Promise<string | null> {
  if (!(await referralRule()).enabled) return null;
  const partner = await db.query.deliveryPartners.findFirst({
    where: and(eq(deliveryPartners.id, partnerId), isNull(deliveryPartners.deletedAt)),
    columns: { id: true, status: true, referralCode: true },
  });
  if (!partner || partner.status !== "APPROVED") return null;
  if (partner.referralCode) return partner.referralCode;

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const [row] = await db
        .update(deliveryPartners)
        .set({ referralCode: newReferralCode() })
        .where(and(eq(deliveryPartners.id, partnerId), isNull(deliveryPartners.referralCode)))
        .returning({ code: deliveryPartners.referralCode });
      if (row?.code) return row.code;
      // Someone else set it in between: read it back.
      const again = await db.query.deliveryPartners.findFirst({
        where: eq(deliveryPartners.id, partnerId),
        columns: { referralCode: true },
      });
      return again?.referralCode ?? null;
    } catch (error) {
      if (!uniqueViolation(error)) throw error; // the code is taken: try another
    }
  }
  throw conflict("Could not create a referral code. Please try again.");
}

/* ------------------------------------------------------------ registration */

/**
 * Checks a referral code given at registration, before the application is written. Returns the
 * referrer's partner id, or null when no code was given or the rule is off (the code is then
 * ignored). An unknown code, a rider who is not approved or the applicant's own code is refused.
 */
export async function resolveReferrerForRegistration(rawCode: string | null | undefined, applicantUserId: string): Promise<string | null> {
  if (!rawCode || !rawCode.trim()) return null;
  if (!(await referralRule()).enabled) return null;
  const message = "This referral code is not valid. Check it with the rider who shared it, or leave it empty.";
  const code = normaliseReferralCode(rawCode);
  if (!code) throw validationFailed(message, { fields: { referralCode: message } });
  const referrer = await db.query.deliveryPartners.findFirst({
    where: and(eq(deliveryPartners.referralCode, code), isNull(deliveryPartners.deletedAt)),
    columns: { id: true, userId: true, status: true },
  });
  if (!referrer || referrer.status !== "APPROVED") throw validationFailed(message, { fields: { referralCode: message } });
  if (referrer.userId === applicantUserId) {
    const self = "You can't use your own referral code.";
    throw validationFailed(self, { fields: { referralCode: self } });
  }
  return referrer.id;
}

/**
 * Links a just-registered rider to the referrer and writes the PENDING referral with today's
 * terms. Idempotent (one referral per referred rider). Never throws: a failure here must not
 * undo a registration that already succeeded.
 */
export async function recordReferral(referredPartnerId: string, referrerPartnerId: string): Promise<RiderReferral | null> {
  if (referredPartnerId === referrerPartnerId) return null;
  try {
    const rule = await referralRule();
    if (!rule.enabled) return null;
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(riderReferrals)
        .values({
          referrerPartnerId,
          referredPartnerId,
          status: "PENDING",
          deliveriesRequired: rule.deliveriesRequired,
          withinDays: rule.withinDays,
          rewardPaise: rule.rewardPaise,
        })
        .onConflictDoNothing()
        .returning();
      if (row) {
        await tx
          .update(deliveryPartners)
          .set({ referredByPartnerId: referrerPartnerId })
          .where(and(eq(deliveryPartners.id, referredPartnerId), isNull(deliveryPartners.referredByPartnerId)));
      }
      return row ?? null;
    });
  } catch (error) {
    console.error("[rider-referrals] could not record referral", referredPartnerId, error);
    return null;
  }
}

/* ----------------------------------------------------------- qualification */

/** When the rider was first approved (the audit trail), or their review time if that is missing. */
async function approvedAtFor(partnerIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (partnerIds.length === 0) return out;
  const rows = await db
    .select({ id: auditLogs.entityId, at: sql<Date>`min(${auditLogs.createdAt})` })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.entityType, "delivery_partner"),
        inArray(auditLogs.entityId, partnerIds),
        eq(auditLogs.action, AUDIT_ACTIONS.DELIVERY_PARTNER_STATUS_CHANGED),
        sql`${auditLogs.newValue}->>'status' = 'APPROVED'`,
      ),
    )
    .groupBy(auditLogs.entityId);
  for (const r of rows) if (r.id && r.at) out.set(r.id, new Date(r.at));
  const missing = partnerIds.filter((id) => !out.has(id));
  if (missing.length > 0) {
    const partners = await db
      .select({ id: deliveryPartners.id, status: deliveryPartners.status, reviewedAt: deliveryPartners.reviewedAt })
      .from(deliveryPartners)
      .where(inArray(deliveryPartners.id, missing));
    for (const p of partners) if (p.status === "APPROVED" && p.reviewedAt) out.set(p.id, p.reviewedAt);
  }
  return out;
}

async function deliveriesBetween(partnerId: string, from: Date, to: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(deliveryOrders)
    .where(
      and(
        eq(deliveryOrders.deliveryPartnerId, partnerId),
        eq(deliveryOrders.status, "DELIVERED"),
        gte(deliveryOrders.deliveredAt, from),
        lte(deliveryOrders.deliveredAt, to),
      ),
    );
  return Number(row?.n ?? 0);
}

export type QualificationResult = "NONE" | "WAITING_APPROVAL" | "PENDING" | "QUALIFIED" | "EXPIRED";

/**
 * Call after each delivery credit for the rider who delivered (the referred rider). Cheap when
 * there is no pending referral (one indexed read). Never throws.
 */
export async function checkReferralQualification(referredPartnerId: string, now: Date = new Date()): Promise<QualificationResult> {
  try {
    const referral = await db.query.riderReferrals.findFirst({ where: eq(riderReferrals.referredPartnerId, referredPartnerId) });
    if (!referral) return "NONE";
    if (referral.status !== "PENDING") return referral.status;

    const approvedAt = (await approvedAtFor([referredPartnerId])).get(referredPartnerId) ?? null;
    if (!approvedAt) return "WAITING_APPROVAL";
    const deadline = new Date(approvedAt.getTime() + referral.withinDays * 86_400_000);
    const delivered = await deliveriesBetween(referredPartnerId, approvedAt, deadline);
    const { state } = referralState({
      approvedAt,
      withinDays: referral.withinDays,
      deliveriesRequired: referral.deliveriesRequired,
      deliveriesInWindow: delivered,
      now,
    });

    if (state === "EXPIRED") {
      await db
        .update(riderReferrals)
        .set({ status: "EXPIRED" })
        .where(and(eq(riderReferrals.id, referral.id), eq(riderReferrals.status, "PENDING")));
      return "EXPIRED";
    }
    if (state !== "QUALIFIED") return "PENDING";
    await qualify(referral, now);
    return "QUALIFIED";
  } catch (error) {
    console.error("[rider-referrals] qualification check failed", referredPartnerId, error);
    return "PENDING";
  }
}

async function qualify(referral: RiderReferral, now: Date): Promise<void> {
  const [referred, referrer] = await Promise.all([
    db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.id, referral.referredPartnerId), columns: { fullName: true } }),
    db.query.deliveryPartners.findFirst({ where: eq(deliveryPartners.id, referral.referrerPartnerId), columns: { userId: true } }),
  ]);
  const firstName = referred?.fullName.trim().split(/\s+/)[0] || "Your referral";

  // 1. The reward: an idempotent rider adjustment (same key every time), paid with the next payout.
  let adjustmentId: string | null = null;
  if (referral.rewardPaise > 0) {
    const input = {
      type: "RIDER_ADJUSTMENT" as const,
      deliveryPartnerId: referral.referrerPartnerId,
      amountPaise: referral.rewardPaise,
      reason: `Refer & Earn reward: ${firstName} completed ${referral.deliveriesRequired} deliveries`,
      requestId: `rider-referral:${referral.id}`,
    };
    try {
      adjustmentId = (await recordAdjustment(input, SYSTEM_ACTOR)).id;
    } catch (error) {
      // Two checks at once: the other one wrote the adjustment; read it back by the same key.
      if (!uniqueViolation(error)) throw error;
      adjustmentId = (await recordAdjustment(input, SYSTEM_ACTOR)).id;
    }
  }

  // 2. The referral: PENDING → QUALIFIED once; only the winner audits and notifies.
  const [row] = await db
    .update(riderReferrals)
    .set({ status: "QUALIFIED", qualifiedAt: now, paidAdjustmentId: adjustmentId })
    .where(and(eq(riderReferrals.id, referral.id), eq(riderReferrals.status, "PENDING")))
    .returning();
  if (!row) return;

  await recordAudit({
    action: AUDIT_ACTIONS.RIDER_REFERRAL_QUALIFIED,
    entityType: "rider_referral",
    entityId: row.id,
    previousValue: { status: "PENDING" },
    newValue: {
      status: "QUALIFIED",
      referrerPartnerId: row.referrerPartnerId,
      referredPartnerId: row.referredPartnerId,
      rewardPaise: row.rewardPaise,
      paidAdjustmentId: adjustmentId,
    },
  });
  if (referrer?.userId) {
    await notify({
      userId: referrer.userId,
      type: NOTIFICATION_TYPES.RIDER_REFERRAL_QUALIFIED,
      vars: { name: firstName, amount: formatPaiseCompact(row.rewardPaise) },
      actionUrl: "/delivery-partner/refer",
      dedupeKey: `rider-referral-qualified:${row.id}`,
      lang: "auto",
    });
  }
}

/* --------------------------------------------------------------- rider view */

export interface MyReferralRow {
  id: string;
  /** First name only — never the referred rider's mobile or other details. */
  name: string;
  status: "PENDING" | "QUALIFIED" | "EXPIRED" | "WAITING_APPROVAL";
  delivered: number;
  required: number;
  daysLeft: number | null;
  rewardPaise: number;
  createdAt: string;
}

export interface MyReferralsView {
  enabled: boolean;
  approved: boolean;
  code: string | null;
  terms: { rewardPaise: number; deliveriesRequired: number; withinDays: number };
  referrals: MyReferralRow[];
  earnedPaise: number;
}

export async function getMyReferrals(partnerId: string, now: Date = new Date()): Promise<MyReferralsView> {
  const rule = await referralRule();
  const terms = { rewardPaise: rule.rewardPaise, deliveriesRequired: rule.deliveriesRequired, withinDays: rule.withinDays };
  const partner = await db.query.deliveryPartners.findFirst({
    where: eq(deliveryPartners.id, partnerId),
    columns: { status: true },
  });
  const approved = partner?.status === "APPROVED";
  if (!rule.enabled) return { enabled: false, approved, code: null, terms, referrals: [], earnedPaise: 0 };

  const code = approved ? await ensureReferralCode(partnerId) : null;
  const rows = await db
    .select({
      id: riderReferrals.id,
      referredPartnerId: riderReferrals.referredPartnerId,
      status: riderReferrals.status,
      deliveriesRequired: riderReferrals.deliveriesRequired,
      withinDays: riderReferrals.withinDays,
      rewardPaise: riderReferrals.rewardPaise,
      createdAt: riderReferrals.createdAt,
      fullName: deliveryPartners.fullName,
    })
    .from(riderReferrals)
    .innerJoin(deliveryPartners, eq(deliveryPartners.id, riderReferrals.referredPartnerId))
    .where(eq(riderReferrals.referrerPartnerId, partnerId))
    .orderBy(desc(riderReferrals.createdAt))
    .limit(200);

  const approvedAt = await approvedAtFor(rows.map((r) => r.referredPartnerId));
  const referrals: MyReferralRow[] = [];
  for (const r of rows) {
    const at = approvedAt.get(r.referredPartnerId) ?? null;
    const delivered = at ? await deliveriesBetween(r.referredPartnerId, at, new Date(at.getTime() + r.withinDays * 86_400_000)) : 0;
    const view = referralState({ approvedAt: at, withinDays: r.withinDays, deliveriesRequired: r.deliveriesRequired, deliveriesInWindow: delivered, now });
    // The stored status wins once it is final. A PENDING row that has reached its target or run
    // out of time is settled now (idempotent; the delivery hook normally does it first).
    let status: MyReferralRow["status"] = r.status === "PENDING" ? view.state : r.status;
    if (r.status === "PENDING" && (view.state === "QUALIFIED" || view.state === "EXPIRED")) {
      const settled = await checkReferralQualification(r.referredPartnerId, now);
      status = settled === "QUALIFIED" || settled === "EXPIRED" ? settled : "PENDING";
    }
    referrals.push({
      id: r.id,
      name: r.fullName.trim().split(/\s+/)[0] || "Rider",
      status,
      delivered: Math.min(delivered, r.deliveriesRequired),
      required: r.deliveriesRequired,
      daysLeft: status === "PENDING" ? view.daysLeft : null,
      rewardPaise: r.rewardPaise,
      createdAt: r.createdAt.toISOString(),
    });
  }
  const earnedPaise = referrals.filter((r) => r.status === "QUALIFIED").reduce((sum, r) => sum + r.rewardPaise, 0);
  return { enabled: true, approved, code, terms, referrals, earnedPaise };
}
