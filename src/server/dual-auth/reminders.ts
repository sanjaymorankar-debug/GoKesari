/**
 * docs/dual-auth-2026-11: reminders for shop owners whose account has one verified factor — mostly shops registered
 * with a mobile number alone, which must add and verify an e-mail. In-app notice + SMS, every rule
 * dualAuth.reminderEveryDays (3) days between 10:00 and 19:00 IST, until both are verified. The shop is never taken
 * offline. Hourly job (cron/schedule.ts); nothing is sent while dual_auth is not in force.
 */
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { shops, users } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { NOTIFICATION_TYPES, notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { dualAuthInForce, syncNeedsSecondFactor } from "./policy";

const BATCH = 200;

function istHour(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(now)) % 24;
}

export async function runSecondFactorReminders(now: Date = new Date()): Promise<{ checked: number; reminded: number; skipped?: string }> {
  if (!(await dualAuthInForce())) return { checked: 0, reminded: 0, skipped: "not_in_force" };
  const hour = istHour(now);
  if (hour < 10 || hour >= 19) return { checked: 0, reminded: 0, skipped: "outside_10_19_ist" };
  const { reminderEveryDays } = await getRule("dualAuth");
  const due = new Date(now.getTime() - reminderEveryDays * 24 * 3_600_000);
  const owners = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(shops, eq(shops.ownerId, users.id))
    .where(
      and(
        eq(users.needsSecondFactor, true),
        isNull(users.deletedAt),
        eq(users.status, "ACTIVE"),
        isNull(shops.deletedAt),
        inArray(shops.status, ["APPROVED", "PENDING_APPROVAL", "SUSPENDED"]),
        or(isNull(users.secondFactorRemindedAt), lt(users.secondFactorRemindedAt, due)),
      ),
    )
    .limit(BATCH);
  let reminded = 0;
  for (const { id } of owners) {
    const state = await syncNeedsSecondFactor(id);
    if (!state || state.missing.length === 0) continue;
    // Claim first, so two runs never remind twice.
    const [claimed] = await db
      .update(users)
      .set({ secondFactorRemindedAt: now })
      .where(and(eq(users.id, id), or(isNull(users.secondFactorRemindedAt), lt(users.secondFactorRemindedAt, due))))
      .returning({ id: users.id });
    if (!claimed) continue;
    const missing = state.missing.length === 2 ? "mobile number and e-mail" : state.missing[0] === "MOBILE" ? "mobile number" : "e-mail";
    await notify({
      userId: id,
      type: NOTIFICATION_TYPES.SECURITY_SECOND_FACTOR_NEEDED,
      vars: { missing },
      actionUrl: "/account/verify",
      channels: ["IN_APP", "SMS"],
      dedupeKey: `dual-auth-reminder:${id}:${now.toISOString().slice(0, 10)}`,
    });
    await recordAudit({ action: AUDIT_ACTIONS.DUAL_AUTH_REMINDER_SENT, entityType: "user", entityId: id, newValue: { missing: state.missing } });
    reminded += 1;
  }
  return { checked: owners.length, reminded };
}

/** Counts for the admin report and the final report: accounts marked needs_second_factor. */
export async function needsSecondFactorCounts() {
  const [row] = await db
    .select({
      total: sql<number>`count(*) filter (where ${users.needsSecondFactor})::int`,
      customers: sql<number>`count(*) filter (where ${users.needsSecondFactor} and ${users.role} = 'CUSTOMER')::int`,
      shopOwners: sql<number>`count(*) filter (where ${users.needsSecondFactor} and ${users.role} = 'SHOP_OWNER')::int`,
      noVerifiedMobile: sql<number>`count(*) filter (where ${users.needsSecondFactor} and ${users.phoneVerifiedAt} is null)::int`,
      placeholderEmail: sql<number>`count(*) filter (where ${users.needsSecondFactor} and ${users.emailPlaceholder})::int`,
      live: sql<number>`count(*)::int`,
    })
    .from(users)
    .where(isNull(users.deletedAt));
  return row;
}
