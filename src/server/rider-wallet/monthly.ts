/**
 * Monthly rider payout (docs/gig-bank-payouts-2026-10; flag
 * rider_monthly_payout_enabled). On the 5th from 09:00 IST (rule riderPayouts
 * payoutDayOfMonth / payoutHourIst) every delivery partner is paid what is
 * still unpaid for the previous calendar month — earnings and rider
 * adjustments dated before the month's end that no weekly batch or withdrawal
 * has taken (owner, 31 Oct 2026: the weekly payout stays).
 *
 * Eligible: APPROVED (KYC complete), a verified bank account, and at least
 * monthlyMinPaise unpaid; everyone else is carried forward — their earnings
 * stay unpaid for the next run, and they are told why.
 *
 * Runs once per month: rider_payout_runs has one row per month (its id is the
 * batch id). A run that stopped half way (deploy, crash) is resumed by the
 * next hourly call: riders already paid are skipped (one transfer per run and
 * rider, a unique index), transfers created but not sent are sent, and every
 * transfer carries its own idempotency key, so nobody is paid twice however
 * often it is started.
 */
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { conflict, forbidden, isUniqueViolation, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { db } from "@/server/db";
import {
  deliveryPartnerEarnings,
  deliveryPartners,
  financialAdjustments,
  riderBankTransfers,
  riderPayoutRuns,
  type RiderPayoutRun,
  type UserRole,
} from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { isPayoutTime, monthLabel, monthWindow, previousMonthOf } from "./rules";
import { activeRiderProvider, claimIntoTransfer, payableAccount, railFor, sendTransfer, type SystemOrActor } from "./transfers";
import { kycComplete } from "./withdrawals";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface SkippedRider {
  deliveryPartnerId: string;
  name: string;
  reason: "KYC_INCOMPLETE" | "BANK_NOT_VERIFIED" | "BELOW_MINIMUM" | "NOTHING_DUE";
  amountPaise: number;
}

export type MonthlyRunResult =
  | { skipped: string }
  | { month: string; runId: string; resumed: boolean; alreadyDone: boolean; created: number; skipped: number; sent: number };

const REASON_TEXT: Record<SkippedRider["reason"], string> = {
  KYC_INCOMPLETE: "your delivery partner account is not approved yet.",
  BANK_NOT_VERIFIED: "you have no verified bank account. Add and verify it under My wallet.",
  BELOW_MINIMUM: "it is below the minimum payout.",
  NOTHING_DUE: "nothing was due.",
};

/** Riders with anything unpaid from before `end`. */
async function ridersWithUnpaid(end: Date): Promise<string[]> {
  const fromEarnings = await db
    .selectDistinct({ id: deliveryPartnerEarnings.deliveryPartnerId })
    .from(deliveryPartnerEarnings)
    .where(and(isNull(deliveryPartnerEarnings.payoutId), lt(deliveryPartnerEarnings.createdAt, end)));
  const fromAdjustments = await db
    .selectDistinct({ id: financialAdjustments.deliveryPartnerId })
    .from(financialAdjustments)
    .where(and(eq(financialAdjustments.party, "RIDER"), eq(financialAdjustments.status, "PENDING"), isNull(financialAdjustments.payoutId), lt(financialAdjustments.createdAt, end)));
  return [...new Set([...fromEarnings, ...fromAdjustments].map((r) => r.id).filter((id): id is string => Boolean(id)))];
}

/**
 * The hourly job: pays the previous month when it is payout time and the flag
 * is on. `force` (an admin's "run now") skips the time check, not the flag.
 */
export async function runMonthlyRiderPayout(options: { now?: Date; actor?: SystemOrActor; month?: string; force?: boolean } = {}): Promise<MonthlyRunResult> {
  const now = options.now ?? new Date();
  const actor = options.actor ?? { id: null, role: null };
  if (!(await isFeatureEnabled("rider_monthly_payout_enabled"))) return { skipped: "Monthly rider payout is off (feature flag)." };
  const rule = await getRule("riderPayouts");
  if (!options.force && !isPayoutTime(rule, now)) return { skipped: "Not payout time." };
  const month = options.month ?? previousMonthOf(now);
  if (!MONTH.test(month)) throw validationFailed("Give the month as YYYY-MM.");
  const { end } = monthWindow(month);
  if (end.getTime() > now.getTime()) throw conflict(`${monthLabel(month)} is not over yet.`);

  const [existing] = await db.select().from(riderPayoutRuns).where(eq(riderPayoutRuns.periodMonth, month));
  if (existing && existing.status !== "RUNNING") {
    return { month, runId: existing.id, resumed: false, alreadyDone: true, created: 0, skipped: 0, sent: 0 };
  }
  const provider = await activeRiderProvider();
  if (!provider) return { skipped: `Bank transfers are not available (rule riderPayouts.provider ${rule.provider}): the run waits.` };

  let run: RiderPayoutRun;
  let resumed = false;
  if (existing) {
    [run] = await db.update(riderPayoutRuns).set({ runs: sql`${riderPayoutRuns.runs} + 1` }).where(eq(riderPayoutRuns.id, existing.id)).returning();
    resumed = true;
  } else {
    const [created] = await db.insert(riderPayoutRuns).values({ periodMonth: month, startedBy: actor.id }).onConflictDoNothing().returning();
    if (!created) {
      // Another runner started it a moment ago: it does the work.
      const [other] = await db.select().from(riderPayoutRuns).where(eq(riderPayoutRuns.periodMonth, month));
      return { month, runId: other.id, resumed: false, alreadyDone: other.status !== "RUNNING", created: 0, skipped: 0, sent: 0 };
    }
    run = created;
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.RIDER_MONTHLY_RUN, entityType: "rider_payout_run", entityId: run.id, newValue: { month, step: "started" } });
  }

  const done = new Set(
    (await db.select({ id: riderBankTransfers.deliveryPartnerId }).from(riderBankTransfers).where(eq(riderBankTransfers.runId, run.id))).map((r) => r.id),
  );
  const skipped: SkippedRider[] = ((run.summary as { skipped?: SkippedRider[] }).skipped ?? []).filter((s) => !done.has(s.deliveryPartnerId));
  const skippedIds = new Set(skipped.map((s) => s.deliveryPartnerId));
  let created = 0;
  const candidates = (await ridersWithUnpaid(end)).filter((id) => !done.has(id) && !skippedIds.has(id));
  const partners = candidates.length ? await db.select().from(deliveryPartners).where(inArray(deliveryPartners.id, candidates)) : [];
  const periodStart = `${month}-01`;
  const periodEnd = new Date(end.getTime() - 1).toISOString().slice(0, 10); // the month's last day (end is IST midnight)

  for (const partner of partners) {
    const skip = (reason: SkippedRider["reason"], amountPaise: number) => {
      skipped.push({ deliveryPartnerId: partner.id, name: partner.fullName, reason, amountPaise });
    };
    if (!kycComplete(partner)) {
      skip("KYC_INCOMPLETE", 0);
      continue;
    }
    const account = await payableAccount(partner.userId);
    if (!account) {
      skip("BANK_NOT_VERIFIED", 0);
      continue;
    }
    let below = 0;
    try {
      const claimed = await db.transaction(async (tx) => {
        await tx.select({ id: deliveryPartners.id }).from(deliveryPartners).where(eq(deliveryPartners.id, partner.id)).for("update");
        return claimIntoTransfer(tx, {
          deliveryPartnerId: partner.id,
          userId: partner.userId,
          kind: "MONTHLY",
          before: end,
          amountPaise: null,
          check: (availablePaise) => {
            if (availablePaise < Math.max(rule.monthlyMinPaise, 1)) {
              below = availablePaise;
              throw new BelowMinimum();
            }
          },
          feePaise: 0,
          account,
          provider,
          mode: railFor(account, rule.monthlyMode),
          runId: run.id,
          periodStart,
          periodEnd,
          actor,
        });
      });
      if (claimed) created += 1;
      else skip("NOTHING_DUE", 0);
    } catch (error) {
      if (error instanceof BelowMinimum) skip(below > 0 ? "BELOW_MINIMUM" : "NOTHING_DUE", below);
      else if (isUniqueViolation(error)) continue; // a concurrent runner paid this rider
      else throw error;
    }
  }

  // Send everything of this run not yet sent — this run's new transfers and any a stopped run left behind.
  const pending = await db.select({ id: riderBankTransfers.id }).from(riderBankTransfers).where(and(eq(riderBankTransfers.runId, run.id), eq(riderBankTransfers.status, "PENDING")));
  for (const t of pending) await sendTransfer(t.id, actor);

  await finishRun(run.id, skipped);
  for (const s of skipped) {
    if (s.reason === "NOTHING_DUE") continue;
    const partner = partners.find((p) => p.id === s.deliveryPartnerId);
    if (!partner) continue;
    await notify({
      userId: partner.userId,
      type: NOTIFICATION_TYPES.RIDER_PAYOUT_CARRIED,
      vars: { month: monthLabel(month), amount: s.amountPaise > 0 ? formatPaise(s.amountPaise) : "your balance", reason: REASON_TEXT[s.reason] },
      dedupeKey: `rider-carry:${month}:${partner.id}`,
      actionUrl: "/gig/wallet",
    });
  }
  return { month, runId: run.id, resumed, alreadyDone: false, created, skipped: skipped.length, sent: pending.length };
}

class BelowMinimum extends Error {}

/** Totals from the run's transfers; COMPLETED once nothing is still on its way. */
export async function finishRun(runId: string, skipped?: SkippedRider[]): Promise<RiderPayoutRun> {
  const [totals] = await db
    .select({
      eligible: sql<number>`count(*)::int`,
      paid: sql<number>`count(*) filter (where ${riderBankTransfers.status} = 'SUCCESS')::int`,
      failed: sql<number>`count(*) filter (where ${riderBankTransfers.status} in ('FAILED', 'REVERSED', 'RELEASED'))::int`,
      open: sql<number>`count(*) filter (where ${riderBankTransfers.status} in ('PENDING', 'PROCESSING') or (${riderBankTransfers.status} = 'FAILED' and not ${riderBankTransfers.needsReview}))::int`,
      gross: sql<string>`coalesce(sum(${riderBankTransfers.grossPaise}), 0)`,
      tds: sql<string>`coalesce(sum(${riderBankTransfers.tdsPaise}), 0)`,
      net: sql<string>`coalesce(sum(${riderBankTransfers.netPaise}), 0)`,
    })
    .from(riderBankTransfers)
    .where(eq(riderBankTransfers.runId, runId));
  const [current] = await db.select().from(riderPayoutRuns).where(eq(riderPayoutRuns.id, runId));
  const keptSkipped = skipped ?? (current.summary as { skipped?: SkippedRider[] }).skipped ?? [];
  const status: RiderPayoutRun["status"] = totals.open > 0 ? "RUNNING" : totals.failed > 0 ? "COMPLETED_WITH_FAILURES" : "COMPLETED";
  const [row] = await db
    .update(riderPayoutRuns)
    .set({
      status,
      eligible: totals.eligible,
      paid: totals.paid,
      failed: totals.failed,
      skipped: keptSkipped.length,
      grossPaise: Number(totals.gross),
      tdsPaise: Number(totals.tds),
      netPaise: Number(totals.net),
      summary: { ...(current.summary as Record<string, unknown>), skipped: keptSkipped },
      finishedAt: status === "RUNNING" ? null : new Date(),
    })
    .where(eq(riderPayoutRuns.id, runId))
    .returning();
  return row;
}

/** Hourly: runs still RUNNING (waiting for the bank or retries) get their totals and status refreshed. */
export async function refreshOpenRuns(): Promise<number> {
  const open = await db.select({ id: riderPayoutRuns.id }).from(riderPayoutRuns).where(eq(riderPayoutRuns.status, "RUNNING"));
  for (const r of open) await finishRun(r.id);
  return open.length;
}

/* ================================================================== admin */

export async function listRuns(limit = 24): Promise<RiderPayoutRun[]> {
  return db.select().from(riderPayoutRuns).orderBy(desc(riderPayoutRuns.periodMonth)).limit(limit);
}

export async function getRun(runId: string) {
  const [run] = await db.select().from(riderPayoutRuns).where(eq(riderPayoutRuns.id, runId));
  if (!run) throw notFound("Payout run");
  const transfers = await db
    .select({ transfer: riderBankTransfers, partnerName: deliveryPartners.fullName })
    .from(riderBankTransfers)
    .innerJoin(deliveryPartners, eq(riderBankTransfers.deliveryPartnerId, deliveryPartners.id))
    .where(eq(riderBankTransfers.runId, runId))
    .orderBy(desc(riderBankTransfers.needsReview), riderBankTransfers.status);
  return { run, transfers };
}

/** Admin "run now" for a past month (ADMIN): the same run, the same once-only guard. */
export async function runMonthNow(month: string, actor: { id: string; role: UserRole }): Promise<MonthlyRunResult> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can start a payout run.");
  return runMonthlyRiderPayout({ actor, month, force: true });
}
