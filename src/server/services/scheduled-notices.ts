/**
 * Notices due later (onboarding Phase 2, WP4 — docs/onboarding-benchmark/phase-2). No polling of the
 * business tables: a row is written, and moved on, by the user's own action, and the every-minute
 * notification job sends the rows that have come due (`deliverDueScheduledNotices`).
 *
 * First use — an unfinished shop registration (owner, 05-Nov-2026, Q3): every time the owner
 * reaches a step, the reminder moves to 24 h later. If they do not come back, they are reminded
 * at 24 h and again 48 h after that (72 h idle), when the dealer whose code they used is told
 * too. Then it stops. Paying or finishing cancels it; coming back starts it over.
 */
import { and, eq, isNull, lte, sql } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { db } from "@/server/db";
import { dealerCodes, dealers, referralCodes, scheduledNotices, shopRegistrationDrafts, shops, users } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { registrationFeeDue } from "./registration-fee-payment";
import { notify } from "./notifications";

export const REGISTRATION_IDLE = "REGISTRATION_IDLE";
const HOUR_MS = 3_600_000;
/** Stage 1 after 24 h without a step; stage 2 another 48 h later (72 h in all). */
export const REGISTRATION_REMINDER_HOURS = [24, 48] as const;

/** Wizard steps before the shop is live, with the words the owner saw. */
// Owner brief 08-Nov-2026: verify → address → map pin → shop name → pay (wizard tiles 1–5).
const STEP_LABEL: Record<string, { label: string; tile: number }> = {
  IDENTITY: { label: "Verify your business (GST or PAN)", tile: 1 },
  EMAIL: { label: "Shop e-mail", tile: 1 },
  OWNER: { label: "Owner name", tile: 1 },
  ADDRESS: { label: "Confirm your shop address", tile: 2 },
  PIN: { label: "Mark your shop on the map", tile: 3 },
  SHOP: { label: "Shop name", tile: 4 },
  FSSAI: { label: "FSSAI licence", tile: 4 },
  REVIEW: { label: "Review and pay", tile: 5 },
  PAYMENT: { label: "Pay the registration fee", tile: 5 },
};
/** The tile where the shop goes live once its last step is done. */
const LIVE_AFTER_TILE = 5;

const registrationKey = (draftId: string) => `registration-idle:${draftId}`;

function siteUrl(path: string): string {
  return `${(getEnv().AUTH_URL ?? "https://gokesari.com").replace(/\/$/, "")}${path}`;
}

/**
 * Called whenever the wizard is shown or a step is saved (toWizardView): a registration that is
 * still before go-live gets its reminder 24 h from now (stage 1 again); any other is cancelled.
 * Best-effort — a failure here never stops the wizard.
 */
export async function syncRegistrationReminder(draft: { id: string; ownerId: string }, nextStep: string, now: Date = new Date()): Promise<void> {
  try {
    const key = registrationKey(draft.id);
    if (!(nextStep in STEP_LABEL)) {
      await db
        .update(scheduledNotices)
        .set({ cancelledAt: now, updatedAt: now })
        .where(and(eq(scheduledNotices.key, key), isNull(scheduledNotices.sentAt), isNull(scheduledNotices.cancelledAt)));
      return;
    }
    const dueAt = new Date(now.getTime() + REGISTRATION_REMINDER_HOURS[0] * HOUR_MS);
    const payload = { draftId: draft.id, ownerId: draft.ownerId, step: nextStep };
    await db
      .insert(scheduledNotices)
      .values({ kind: REGISTRATION_IDLE, key, stage: 1, dueAt, payload })
      .onConflictDoUpdate({
        target: scheduledNotices.key,
        set: { stage: 1, dueAt, payload, sentAt: null, cancelledAt: null, updatedAt: now },
      });
  } catch (error) {
    console.error("[scheduled-notices] registration reminder not scheduled", draft.id, error instanceof Error ? error.message : error);
  }
}

/** Still waiting for the owner: OPEN, or submitted with the fee unpaid. */
async function registrationStillOpen(draftId: string): Promise<boolean> {
  const [draft] = await db
    .select({ status: shopRegistrationDrafts.status, shopId: shopRegistrationDrafts.shopId })
    .from(shopRegistrationDrafts)
    .where(eq(shopRegistrationDrafts.id, draftId));
  if (!draft) return false;
  if (draft.status === "OPEN") return true;
  if (draft.status !== "SUBMITTED" || !draft.shopId) return false;
  const [shop] = await db.select().from(shops).where(eq(shops.id, draft.shopId));
  return Boolean(shop && registrationFeeDue(shop) > 0);
}

/** The dealer (not an internal one) behind the referral code the registration used. */
async function dealerForCode(code: string | null): Promise<{ userId: string } | null> {
  if (!code) return null;
  const [row] = await db
    .select({ userId: dealers.userId, isInternal: dealers.isInternal })
    .from(referralCodes)
    .innerJoin(dealerCodes, eq(dealerCodes.referralCodeId, referralCodes.id))
    .innerJoin(dealers, eq(dealers.id, dealerCodes.dealerId))
    .where(sql`upper(${referralCodes.code}) = upper(${code})`)
    .limit(1);
  return row?.userId && !row.isInternal ? { userId: row.userId } : null;
}

async function sendRegistrationReminder(notice: { id: string; stage: number; dueAt: Date; payload: Record<string, string | null> }): Promise<void> {
  const { draftId, ownerId, step } = notice.payload;
  if (!draftId || !ownerId || !(await registrationStillOpen(draftId))) return;
  const where = STEP_LABEL[step ?? ""] ?? STEP_LABEL.IDENTITY;
  const left = LIVE_AFTER_TILE - where.tile + 1;
  const stamp = notice.dueAt.toISOString();
  await notify({
    userId: ownerId,
    type: NOTIFICATION_TYPES.SHOP_REGISTRATION_IDLE,
    vars: { stepLabel: where.label, stepsLeft: left === 1 ? "1 step" : `${left} steps`, resumeUrl: siteUrl("/shop/register") },
    actionUrl: "/shop/register",
    dedupeKey: `registration-idle:${draftId}:${notice.stage}:${stamp}`,
  });
  if (notice.stage < REGISTRATION_REMINDER_HOURS.length) return;
  const [draft] = await db
    .select({ code: shopRegistrationDrafts.referralCode, ownerName: users.name })
    .from(shopRegistrationDrafts)
    .innerJoin(users, eq(users.id, shopRegistrationDrafts.ownerId))
    .where(eq(shopRegistrationDrafts.id, draftId));
  const dealer = await dealerForCode(draft?.code ?? null);
  if (dealer) {
    await notify({
      userId: dealer.userId,
      type: NOTIFICATION_TYPES.DEALER_REGISTRATION_IDLE,
      vars: { ownerName: draft?.ownerName ?? "A shop owner", code: draft?.code ?? "", stepLabel: where.label },
      actionUrl: "/dealer",
      dedupeKey: `dealer-registration-idle:${draftId}:${stamp}`,
    });
  }
}

/**
 * The every-minute job's second step (cron "notification-retry"): sends the notices that have come
 * due. Each row is claimed before it is sent, so two runs never send one twice; a registration
 * reminder at stage 1 is moved to stage 2, 48 h later.
 */
export async function deliverDueScheduledNotices(options: { now?: Date; limit?: number } = {}): Promise<{ sent: number; skipped: number }> {
  const now = options.now ?? new Date();
  const due = await db
    .select({ id: scheduledNotices.id })
    .from(scheduledNotices)
    .where(and(lte(scheduledNotices.dueAt, now), isNull(scheduledNotices.sentAt), isNull(scheduledNotices.cancelledAt)))
    .orderBy(scheduledNotices.dueAt)
    .limit(options.limit ?? 100);
  let sent = 0;
  let skipped = 0;
  for (const { id } of due) {
    const [notice] = await db
      .update(scheduledNotices)
      .set({ sentAt: now, updatedAt: now })
      .where(and(eq(scheduledNotices.id, id), isNull(scheduledNotices.sentAt), isNull(scheduledNotices.cancelledAt), lte(scheduledNotices.dueAt, now)))
      .returning();
    if (!notice) continue;
    try {
      if (notice.kind === REGISTRATION_IDLE) {
        await sendRegistrationReminder(notice);
        if (notice.stage < REGISTRATION_REMINDER_HOURS.length) {
          await db
            .update(scheduledNotices)
            .set({ stage: notice.stage + 1, dueAt: new Date(now.getTime() + REGISTRATION_REMINDER_HOURS[notice.stage] * HOUR_MS), sentAt: null, updatedAt: now })
            .where(and(eq(scheduledNotices.id, notice.id), eq(scheduledNotices.sentAt, now)));
        }
        sent += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      skipped += 1;
      console.error("[scheduled-notices] not sent", notice.key, error instanceof Error ? error.message : error);
    }
  }
  return { sent, skipped };
}
