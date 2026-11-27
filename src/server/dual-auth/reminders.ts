/**
 * docs/dual-auth-2026-11: reminders for every live account with a missing factor (needs_second_factor) — shop owners
 * first, and since 27-Nov-2026 (owner, login & auth item 7) customers and every other role too. Every rule
 * dualAuth.reminderEveryDays (3) days between 10:00 and 19:00 IST, until both are verified. Shop owners: in-app +
 * SMS (as before). Everyone else: in-app + e-mail (a real address only), SMS only when a number is on file
 * // DEFAULT – confirm with Sanjay. The shop is never taken offline. Hourly job (cron/schedule.ts); nothing is sent
 * while dual_auth is not in force.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

import { isPlaceholderEmail } from "@/lib/placeholder-email";

import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { NOTIFICATION_TYPES, notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { dualAuthInForce, syncNeedsSecondFactor } from "./policy";

const BATCH = 500;

function istHour(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(now)) % 24;
}

export async function runSecondFactorReminders(now: Date = new Date()): Promise<{ checked: number; reminded: number; skipped?: string }> {
  if (!(await dualAuthInForce())) return { checked: 0, reminded: 0, skipped: "not_in_force" };
  const hour = istHour(now);
  if (hour < 10 || hour >= 19) return { checked: 0, reminded: 0, skipped: "outside_10_19_ist" };
  const { reminderEveryDays } = await getRule("dualAuth");
  const due = new Date(now.getTime() - reminderEveryDays * 24 * 3_600_000);
  // Shop owners with a live shop first (as before), then every other account.
  // Written out in full: inside a one-table select, drizzle leaves column names unqualified.
  const shopOwner = sql<boolean>`exists (select 1 from shops s where s.owner_id = "users"."id" and s.deleted_at is null and s.status in ('APPROVED', 'PENDING_APPROVAL', 'SUSPENDED'))`;
  const owners = await db
    .select({ id: users.id, shopOwner, email: users.email, emailPlaceholder: users.emailPlaceholder, phoneE164: users.phoneE164 })
    .from(users)
    .where(
      and(
        eq(users.needsSecondFactor, true),
        isNull(users.deletedAt),
        eq(users.status, "ACTIVE"),
        or(isNull(users.secondFactorRemindedAt), lt(users.secondFactorRemindedAt, due)),
      ),
    )
    .orderBy(sql`${shopOwner} desc`, users.createdAt)
    .limit(BATCH);
  let reminded = 0;
  for (const { id, shopOwner: ownsShop, email, emailPlaceholder, phoneE164 } of owners) {
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
      vars: { missing, shopNote: ownsShop ? " Your shop stays live meanwhile." : "" },
      actionUrl: "/account/verify",
      channels: ownsShop
        ? ["IN_APP", "SMS"]
        : [
            "IN_APP",
            ...(!emailPlaceholder && !isPlaceholderEmail(email) ? (["EMAIL"] as const) : []),
            ...(phoneE164 ? (["SMS"] as const) : []),
          ],
      dedupeKey: `dual-auth-reminder:${id}:${now.toISOString().slice(0, 10)}`,
    });
    await recordAudit({ action: AUDIT_ACTIONS.DUAL_AUTH_REMINDER_SENT, entityType: "user", entityId: id, newValue: { missing: state.missing, shopOwner: ownsShop } });
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
