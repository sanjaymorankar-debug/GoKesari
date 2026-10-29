/**
 * Feature flags (docs/dealer-programme, step 1): the admin switches for the
 * dealer programme.
 *
 *   dealer_programme_enabled                dealers, codes, leads, commission (per district)
 *   gov_verification_auto_approval_enabled  instant shop approval on GST/PAN + payment
 *   dealer_rating_bonus_enabled             rating-linked commission bonus
 *   paid_support_services_enabled           the paid Support Services page
 *
 * Stored in `feature_flags` (seeded OFF by migration 0102) and read live — no
 * cache — so switching one off takes effect on the very next request. With
 * every flag off the site behaves exactly as before: new routes answer
 * "not available" (`requireFeature`) and no existing path changes.
 *
 * A flag can be limited to districts (geo_areas codes): `districtCodes` NULL
 * means every district. `isFeatureEnabled(key, { districtCode })` is true only
 * when the flag is on and covers that district; without a district it asks
 * "is it on anywhere".
 *
 * Only an ADMIN may change a flag (checked here, not only in the route), a
 * reason is required, and every change is written to `feature_flag_changes`
 * and the audit log.
 */
import { stateCodeOfArea } from "@/lib/indian-states";
import { desc, eq, sql } from "drizzle-orm";

import { AppError, forbidden, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  FEATURE_FLAG_KEYS,
  featureFlagChanges,
  featureFlags,
  type FeatureFlagKey,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { listDistricts, listStates } from "./geo-areas";

export const FEATURE_FLAG_LABELS: Record<FeatureFlagKey, string> = {
  dealer_programme_enabled: "Dealer programme",
  gov_verification_auto_approval_enabled: "Instant approval on GST/PAN verification + payment",
  dealer_rating_bonus_enabled: "Dealer rating bonus",
  paid_support_services_enabled: "Paid support services",
  shop_onboarding_wizard_enabled: "Shop onboarding wizard",
};

export const FEATURE_FLAG_HINTS: Record<FeatureFlagKey, string> = {
  dealer_programme_enabled:
    "Dealer applications, dealer and salesperson codes, leads, dealer-assisted registration and dealer commission. Limit it to the pilot districts.",
  gov_verification_auto_approval_enabled:
    "A shop is approved without an admin step when its GSTIN or PAN is verified with the government source, the name matches and the gateway confirms the registration fee. Otherwise it waits for admin approval as today.",
  dealer_rating_bonus_enabled:
    "Each 0.5 of a dealer's rating above 5.0 adds 0.5% to their commission, from the next accrual. Off: every dealer earns the base rate.",
  paid_support_services_enabled:
    "The Support Services page for shop owners: general support, product upload and price update, with the charges set by an admin.",
  shop_onboarding_wizard_enabled:
    "Add my shop opens the step-by-step wizard (GSTIN → details → Udyam → FSSAI → Shop Act → map → payment). A wizard shop whose GST/PAN checks pass goes live right after payment in every district, with its Shop Act reviewed by an admin afterwards. Off: the long form. The wizard is always reachable at /shop/register?wizard=1 for testing.",
};

export interface FeatureFlagView {
  key: FeatureFlagKey;
  enabled: boolean;
  /** NULL = every district. */
  districtCodes: string[] | null;
  updatedAt: Date | null;
}

export interface FeatureFlagChangeView {
  id: string;
  flagKey: FeatureFlagKey;
  oldValue: { enabled: boolean; districtCodes: string[] | null };
  newValue: { enabled: boolean; districtCodes: string[] | null };
  reason: string;
  changedByEmail: string | null;
  changedByRole: string | null;
  changedAt: Date;
}

const OFF = (key: FeatureFlagKey): FeatureFlagView => ({ key, enabled: false, districtCodes: null, updatedAt: null });

/** Every flag. A missing row, or a table that cannot be read, counts as OFF. */
export async function getFeatureFlags(): Promise<Record<FeatureFlagKey, FeatureFlagView>> {
  const out = Object.fromEntries(FEATURE_FLAG_KEYS.map((key) => [key, OFF(key)])) as Record<FeatureFlagKey, FeatureFlagView>;
  try {
    const rows = await db.select().from(featureFlags);
    for (const row of rows) {
      if ((FEATURE_FLAG_KEYS as readonly string[]).includes(row.key)) {
        out[row.key] = { key: row.key, enabled: row.enabled, districtCodes: row.districtCodes ?? null, updatedAt: row.updatedAt };
      }
    }
  } catch (error) {
    console.error("[feature-flags] read failed, treating every flag as off", error);
  }
  return out;
}

export async function getFeatureFlag(key: FeatureFlagKey): Promise<FeatureFlagView> {
  return (await getFeatureFlags())[key];
}

/** Keys of the flags that are on anywhere (for menus: an entry of a feature that is off is hidden). */
export async function enabledFeatureKeys(): Promise<FeatureFlagKey[]> {
  return Object.values(await getFeatureFlags())
    .filter((f) => f.enabled)
    .map((f) => f.key);
}

/** True when the flag's district list covers this district (NULL list = every district). */
export function flagCoversDistrict(flag: Pick<FeatureFlagView, "enabled" | "districtCodes">, districtCode: string | null | undefined): boolean {
  if (!flag.enabled) return false;
  if (flag.districtCodes === null) return true;
  if (districtCode == null) return false;
  // The list may name whole states ("KA") as well as districts ("MH-PUN").
  const state = stateCodeOfArea(districtCode);
  return flag.districtCodes.includes(districtCode) || (state != null && flag.districtCodes.includes(state));
}

/**
 * Is the feature on? With `districtCode` (or `null` for "a shop whose district
 * is unknown"): on for that district. Without the option: on anywhere.
 */
export async function isFeatureEnabled(key: FeatureFlagKey, options: { districtCode?: string | null } = {}): Promise<boolean> {
  const flag = await getFeatureFlag(key);
  if (!("districtCode" in options)) return flag.enabled;
  return flagCoversDistrict(flag, options.districtCode);
}

/** Error for a route of a feature that is switched off: 404, so the site looks as it did before. */
export function featureNotAvailable(key: FeatureFlagKey): AppError {
  return new AppError("NOT_FOUND", "This feature is not available.", { reason: "FEATURE_NOT_AVAILABLE", feature: key });
}

/** Throws "not available" unless the flag is on (for the district, when given). */
export async function requireFeature(key: FeatureFlagKey, options: { districtCode?: string | null } = {}): Promise<void> {
  if (!(await isFeatureEnabled(key, options))) throw featureNotAvailable(key);
}

/**
 * Changes one flag. ADMIN only, a reason of at least 5 characters, and area
 * codes that are active STATE or DISTRICT rows of geo_areas — a whole state
 * ("KA") or a district ("MH-PUN") — (an empty list is refused —
 * switch the flag off instead). Saving the value it already has changes and
 * logs nothing.
 */
export async function setFeatureFlag(
  key: FeatureFlagKey,
  value: { enabled: boolean; districtCodes: string[] | null },
  reason: string,
  actor: { id: string; role: UserRole; email?: string | null },
): Promise<{ flag: FeatureFlagView; changed: boolean }> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can change feature flags.");
  if (!(FEATURE_FLAG_KEYS as readonly string[]).includes(key)) throw validationFailed("Unknown feature flag.");
  const why = reason.trim();
  if (why.length < 5) throw validationFailed("Say why you are changing this flag.", { fields: { reason: "Give a reason (at least 5 characters)." } });

  let districtCodes: string[] | null = null;
  if (value.districtCodes !== null) {
    const wanted = [...new Set(value.districtCodes.map((c) => c.trim().toUpperCase()).filter(Boolean))].sort();
    if (wanted.length === 0) {
      throw validationFailed("Choose at least one state or district, or all of India.", { fields: { districtCodes: "Choose at least one state or district." } });
    }
    const known = new Set([...(await listStates()), ...(await listDistricts())].filter((d) => d.status === "ACTIVE").map((d) => d.code));
    const unknown = wanted.filter((c) => !known.has(c));
    if (unknown.length) {
      throw validationFailed(`Unknown state or district: ${unknown.join(", ")}.`, { fields: { districtCodes: "Choose states or districts from the list." } });
    }
    districtCodes = wanted;
  }
  const next = { enabled: value.enabled, districtCodes };

  return db.transaction(async (tx) => {
    // Locked so two admins switching at once log two clean changes.
    await tx.insert(featureFlags).values({ key, enabled: false }).onConflictDoNothing();
    const [current] = await tx.select().from(featureFlags).where(eq(featureFlags.key, key)).for("update");
    const old = { enabled: current.enabled, districtCodes: current.districtCodes ?? null };
    if (old.enabled === next.enabled && JSON.stringify(old.districtCodes) === JSON.stringify(next.districtCodes)) {
      return { flag: { key, ...old, updatedAt: current.updatedAt }, changed: false };
    }
    const now = new Date();
    await tx
      .update(featureFlags)
      .set({ enabled: next.enabled, districtCodes: next.districtCodes, updatedBy: actor.id, updatedAt: now })
      .where(eq(featureFlags.key, key));
    await tx.insert(featureFlagChanges).values({
      flagKey: key,
      oldValue: old,
      newValue: next,
      reason: why,
      changedBy: actor.id,
      changedByEmail: actor.email ?? null,
      changedByRole: actor.role,
      changedAt: now,
    });
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.FEATURE_FLAG_CHANGED,
        entityType: "feature_flag",
        entityId: key,
        previousValue: old,
        newValue: { ...next, reason: why },
      },
      tx,
    );
    return { flag: { key, ...next, updatedAt: now }, changed: true };
  });
}

/** The most recent changes, newest first (all flags, or one). */
export async function listFeatureFlagChanges(options: { key?: FeatureFlagKey; limit?: number } = {}): Promise<FeatureFlagChangeView[]> {
  const rows = await db
    .select()
    .from(featureFlagChanges)
    .where(options.key ? eq(featureFlagChanges.flagKey, options.key) : sql`true`)
    .orderBy(desc(featureFlagChanges.changedAt))
    .limit(Math.min(options.limit ?? 20, 200));
  return rows.map((r) => ({
    id: r.id,
    flagKey: r.flagKey,
    oldValue: r.oldValue,
    newValue: r.newValue,
    reason: r.reason,
    changedByEmail: r.changedByEmail,
    changedByRole: r.changedByRole,
    changedAt: r.changedAt,
  }));
}
