/**
 * Referral settings (docs/nearby-referral-2026-10, feature 2): whether a
 * referral code is MANDATORY or OPTIONAL
 *   - referral_required_customer — at customer registration (first-time setup;
 *     a new customer's first order is refused without a code when mandatory);
 *   - referral_required_shop — at shop registration (Add my shop, /api/shops;
 *     self-registration, /shop/join, and its auto-approval on payment).
 *
 * Stored in `referral_settings` (seeded OPTIONAL by migration 0074) and read
 * live — no cache — so a change applies to the very next registration. Only
 * an ADMIN may change one (checked here, not only in the route and page);
 * every change is written to `referral_setting_changes` (who, old, new, when)
 * and to the audit log.
 *
 * A change never reaches back: shops already registered keep their status,
 * and a MANDATORY customer setting applies only to customers who joined at or
 * after the moment it was switched to MANDATORY (`since`).
 *
 * These settings replace the `required` switches of the business rules
 * shopReferral and customerSignupReferral, which are no longer read.
 */
import { desc, eq, sql } from "drizzle-orm";

import { forbidden, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  REFERRAL_REQUIREMENTS,
  REFERRAL_SETTING_KEYS,
  referralSettingChanges,
  referralSettings,
  type ReferralRequirement,
  type ReferralSettingKey,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";

export type ReferralAudience = "customer" | "shop";

export const REFERRAL_SETTING_FOR: Record<ReferralAudience, ReferralSettingKey> = {
  customer: "referral_required_customer",
  shop: "referral_required_shop",
};

export const REFERRAL_SETTING_LABELS: Record<ReferralSettingKey, string> = {
  referral_required_customer: "Customer registration",
  referral_required_shop: "Shop owner registration",
};

/** The value used when the row is missing (or the table cannot be read): the migration's default. */
export const DEFAULT_REFERRAL_REQUIREMENT: ReferralRequirement = "OPTIONAL";

export interface ReferralSettingView {
  key: ReferralSettingKey;
  value: ReferralRequirement;
  /** When the current value was set (the migration's time until an admin changes it). */
  since: Date | null;
}

export interface ReferralSettingChangeView {
  id: string;
  settingKey: ReferralSettingKey;
  oldValue: ReferralRequirement;
  newValue: ReferralRequirement;
  changedByEmail: string | null;
  changedByRole: string | null;
  changedAt: Date;
}

export async function getReferralSettings(): Promise<Record<ReferralSettingKey, ReferralSettingView>> {
  const out = Object.fromEntries(
    REFERRAL_SETTING_KEYS.map((key) => [key, { key, value: DEFAULT_REFERRAL_REQUIREMENT, since: null }]),
  ) as Record<ReferralSettingKey, ReferralSettingView>;
  try {
    const rows = await db.select().from(referralSettings);
    for (const row of rows) {
      if ((REFERRAL_SETTING_KEYS as readonly string[]).includes(row.key)) {
        out[row.key] = { key: row.key, value: row.value, since: row.updatedAt };
      }
    }
  } catch (error) {
    console.error("[referral-settings] read failed, using OPTIONAL", error);
  }
  return out;
}

export async function getReferralSetting(audience: ReferralAudience): Promise<ReferralSettingView> {
  return (await getReferralSettings())[REFERRAL_SETTING_FOR[audience]];
}

/** True when a referral code is mandatory for this kind of registration right now. */
export async function isReferralRequired(audience: ReferralAudience): Promise<boolean> {
  return (await getReferralSetting(audience)).value === "MANDATORY";
}

/**
 * Changes one setting. ADMIN only — operators, shop owners and customers are
 * refused here whatever route they came through. Setting the value it already
 * has changes and logs nothing.
 */
export async function setReferralSetting(
  key: ReferralSettingKey,
  value: ReferralRequirement,
  actor: { id: string; role: UserRole; email?: string | null },
): Promise<{ setting: ReferralSettingView; changed: boolean }> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can change referral settings.");
  if (!(REFERRAL_SETTING_KEYS as readonly string[]).includes(key)) throw validationFailed("Unknown referral setting.");
  if (!(REFERRAL_REQUIREMENTS as readonly string[]).includes(value)) {
    throw validationFailed("Choose Mandatory or Optional.", { fields: { value: "Choose Mandatory or Optional." } });
  }

  const result = await db.transaction(async (tx) => {
    // The row is locked so two admins switching at once log two clean changes.
    await tx.insert(referralSettings).values({ key, value: DEFAULT_REFERRAL_REQUIREMENT }).onConflictDoNothing();
    const [current] = await tx.select().from(referralSettings).where(eq(referralSettings.key, key)).for("update");
    if (current.value === value) {
      return { setting: { key, value, since: current.updatedAt }, changed: false, oldValue: current.value };
    }
    const now = new Date();
    const [row] = await tx
      .update(referralSettings)
      .set({ value, updatedBy: actor.id, updatedAt: now })
      .where(eq(referralSettings.key, key))
      .returning();
    await tx.insert(referralSettingChanges).values({
      settingKey: key,
      oldValue: current.value,
      newValue: value,
      changedBy: actor.id,
      changedByEmail: actor.email ?? null,
      changedByRole: actor.role,
      changedAt: now,
    });
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.REFERRAL_SETTING_CHANGED,
        entityType: "referral_setting",
        entityId: key,
        previousValue: { value: current.value },
        newValue: { value },
      },
      tx,
    );
    return { setting: { key, value: row.value, since: row.updatedAt }, changed: true, oldValue: current.value };
  });
  return { setting: result.setting, changed: result.changed };
}

/** The most recent changes, newest first (all settings, or one). */
export async function listReferralSettingChanges(
  options: { key?: ReferralSettingKey; limit?: number } = {},
): Promise<ReferralSettingChangeView[]> {
  const rows = await db
    .select()
    .from(referralSettingChanges)
    .where(options.key ? eq(referralSettingChanges.settingKey, options.key) : sql`true`)
    .orderBy(desc(referralSettingChanges.changedAt))
    .limit(Math.min(options.limit ?? 20, 200));
  return rows.map((r) => ({
    id: r.id,
    settingKey: r.settingKey,
    oldValue: r.oldValue,
    newValue: r.newValue,
    changedByEmail: r.changedByEmail,
    changedByRole: r.changedByRole,
    changedAt: r.changedAt,
  }));
}
