/**
 * Franchise commercial configuration (brief §3, §8, §9, §17), versioned with an effective time
 * (franchise_config_versions). A booking, allocation and commission entry remembers the version in force
 * when it was made. Every value is server-side; the client never sends a price or a percentage.
 */
import { desc, eq, gt, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { forbidden, validationFailed } from "@/lib/errors";
import { istMonth, istMonthBounds } from "@/lib/franchise";
import type { BonusSettings } from "@/lib/franchise-bonus";
import { db, type DbClient } from "@/server/db";
import { franchiseConfigVersions, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const franchiseConfigSchema = z
  .object({
    /** Master switch: no booking or payment while false (zones and pages still show). */
    bookingOpen: z.boolean(),
    /** Regions shown in the booking flow and API (brief §4.1). Only PMR exists in this release. */
    regionsEnabled: z.array(z.string().min(1)).min(1),
    /** Launch fee per area per term, paise, before GST. */
    feePerAreaPaise: int(1, 1_000_000_000),
    gstRateBp: int(0, 5_000),
    validityMonths: int(1, 60),
    /** Super-admin only (brief §4.4); the database never allows more than 2. */
    maxOwnersPerZone: int(1, 2),
    reservationHoldMinutes: int(5, 120),
    maxAreaRadiusKm: z.number().min(0.5).max(50),
    maxAreasPerBooking: int(1, 91),
    launchMaxOwners: int(0, 10_000),
    launchMaxAreas: int(0, 10_000),
    launchCloseRule: z.enum(["first_limit_reached", "owners_only", "areas_only"]),
    /** Blank (null) by default: after the launch offer closes, booking shows "new terms coming soon" (D7). */
    postLaunchFeePaise: int(1, 1_000_000_000).nullable(),
    postLaunchOneTimeBp: int(0, 10_000).nullable(),
    postLaunchRecurringBp: int(0, 10_000).nullable(),
    /** One-time commission, bp of the shop registration fee excluding GST — all shop types (D3). */
    oneTimeBp: int(0, 10_000),
    /** Recurring share of GoKesari's order commission, and the most a bonus can add (brief 21-Nov §2). */
    recurringBaseBp: int(0, 10_000),
    bonusMaxBp: int(0, 10_000),
    /** GoKesari's order commission on delivered order value (200 = 2%). */
    gokesariCommissionBp: int(0, 10_000),
    /** Monthly bonus (brief 21-Nov §2–§3): target, expected business per shop, slot, points. */
    monthlyShopTarget: int(0, 100_000),
    expectedBusinessPerShopPaise: int(0, 10_000_000_000),
    businessSlotPaise: int(1, 10_000_000_000),
    basePointsPerMainPoint: int(1, 1_000_000),
    bonusBpPerMainPoint: int(0, 10_000),
    /** Areas are 5 km circles around their centre (brief 21-Nov §1.1): neighbouring areas may overlap; the code decides. */
    allowOverlappingAreas: z.boolean(),
    /** Month-end (brief 21-Nov §5): calculation runs on days 1..calcLastDay, statements on statementDay at statementHourIst. */
    calcLastDay: int(1, 4),
    statementDay: int(2, 5),
    statementHourIst: int(0, 23),
    /** Renewal fee; null = the fee then in force (launch owners: the launch fee). */
    renewalFeePaise: int(1, 1_000_000_000).nullable(),
    renewalWindowDays: int(1, 365),
    tailMode: z.enum(["fixed_end_of_year_3", "years_after_lapse"]),
    tailYears: int(0, 10),
    franchiseCodeOutsideZone: z.enum(["reject", "treat_as_model_A_direct_20"]),
    freeDealerInFranchisedZone: z.enum(["allow", "allow_and_notify_franchise", "block"]),
    expiryCc: z.array(z.string().email()).max(10),
    reminderHourIst: int(0, 23),
    digestHourIst: int(0, 23),
    /** Recurring calculation for month M on the 1st of M+1 at this IST hour. */
    calcHourIst: int(0, 23),
    payoutOnNextWorkingDay: z.boolean(),
    bankHolidays: z.array(isoDate).max(200),
    /** Test server only: shift "now" by this many days for expiry / renewal / tail tests. Refused on production. */
    clockOffsetDays: int(-3650, 3650),
  })
  .refine((c) => c.recurringBaseBp + c.bonusMaxBp <= 10_000, { message: "Share plus bonus cannot pass 100%.", path: ["bonusMaxBp"] });

export type FranchiseConfig = z.infer<typeof franchiseConfigSchema>;

/** Brief defaults (§3, §17). */
export const FRANCHISE_DEFAULTS: FranchiseConfig = {
  bookingOpen: false,
  regionsEnabled: ["PMR"],
  feePerAreaPaise: 15_000_000,
  gstRateBp: 1800,
  validityMonths: 12,
  maxOwnersPerZone: 2,
  reservationHoldMinutes: 15,
  maxAreaRadiusKm: 5,
  maxAreasPerBooking: 10,
  launchMaxOwners: 25,
  launchMaxAreas: 25,
  launchCloseRule: "first_limit_reached",
  postLaunchFeePaise: null,
  postLaunchOneTimeBp: null,
  postLaunchRecurringBp: null,
  oneTimeBp: 2500,
  recurringBaseBp: 2500,
  bonusMaxBp: 500,
  gokesariCommissionBp: 200,
  monthlyShopTarget: 60,
  expectedBusinessPerShopPaise: 10_000_000,
  businessSlotPaise: 500_000,
  basePointsPerMainPoint: 100,
  bonusBpPerMainPoint: 100,
  allowOverlappingAreas: true,
  calcLastDay: 3,
  statementDay: 4,
  statementHourIst: 10,
  renewalFeePaise: null,
  renewalWindowDays: 30,
  // Owner brief 21-Nov-2026 §6: the base share continues for up to 2 years after expiry (replaces D4's default).
  tailMode: "years_after_lapse",
  tailYears: 2,
  franchiseCodeOutsideZone: "reject",
  freeDealerInFranchisedZone: "allow",
  expiryCc: ["ceo@agtci.com"],
  reminderHourIst: 10,
  digestHourIst: 9,
  calcHourIst: 2,
  payoutOnNextWorkingDay: true,
  bankHolidays: [],
  clockOffsetDays: 0,
};

export interface VersionedConfig {
  version: number;
  effectiveFrom: Date;
  config: FranchiseConfig;
}

/** Stored values over the defaults (a stored value missing a newer key keeps working). */
function parse(raw: unknown): FranchiseConfig {
  const merged = { ...FRANCHISE_DEFAULTS, ...((raw ?? {}) as Partial<FranchiseConfig>) };
  const parsed = franchiseConfigSchema.safeParse(merged);
  return parsed.success ? parsed.data : FRANCHISE_DEFAULTS;
}

/** Version 1 (the brief's defaults) is written on first use, so bookings always reference a stored version. */
async function ensureFirstVersion(client: DbClient): Promise<void> {
  await client
    .insert(franchiseConfigVersions)
    .values({ version: 1, effectiveFrom: new Date("2026-11-20T17:20:00Z"), config: FRANCHISE_DEFAULTS as unknown as Record<string, unknown>, reason: "Brief defaults (owner prompt 20-Nov-2026)" })
    .onConflictDoNothing();
}

/** The configuration in force at `at` (default now). */
export async function franchiseConfigAt(at: Date = new Date(), client: DbClient = db): Promise<VersionedConfig> {
  let [row] = await client.select().from(franchiseConfigVersions).where(lte(franchiseConfigVersions.effectiveFrom, at)).orderBy(desc(franchiseConfigVersions.effectiveFrom), desc(franchiseConfigVersions.version)).limit(1);
  if (!row) {
    await ensureFirstVersion(client);
    [row] = await client.select().from(franchiseConfigVersions).orderBy(franchiseConfigVersions.version).limit(1);
  }
  return { version: row.version, effectiveFrom: row.effectiveFrom, config: parse(row.config) };
}

export const franchiseConfig = (client: DbClient = db) => franchiseConfigAt(new Date(), client);

export async function configVersion(version: number, client: DbClient = db): Promise<FranchiseConfig> {
  const [row] = await client.select().from(franchiseConfigVersions).where(eq(franchiseConfigVersions.version, version));
  return parse(row?.config);
}

export async function listConfigVersions(): Promise<{ version: number; effectiveFrom: Date; reason: string; createdAt: Date; config: FranchiseConfig }[]> {
  await ensureFirstVersion(db);
  const rows = await db.select().from(franchiseConfigVersions).orderBy(desc(franchiseConfigVersions.version));
  return rows.map((r) => ({ version: r.version, effectiveFrom: r.effectiveFrom, reason: r.reason, createdAt: r.createdAt, config: parse(r.config) }));
}

export interface Actor {
  id: string;
  role: UserRole;
  /** Super-admin: may change maxOwnersPerZone (brief §4.4). */
  superAdmin?: boolean;
}

const isProduction = () => (process.env.APP_BASE_URL ?? process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "") === "https://gokesari.com";

/**
 * Saves a new version effective at `effectiveFrom` (default now). Only an admin; maxOwnersPerZone only
 * by a super-admin; the test clock never on production. Audited with the reason.
 */
export async function saveFranchiseConfig(patch: Partial<FranchiseConfig>, input: { reason: string; effectiveFrom?: Date }, actor: Actor): Promise<VersionedConfig> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can change the franchise settings.");
  const reason = input.reason.trim();
  if (reason.length < 5) throw validationFailed("Give a reason of at least 5 characters.");
  const current = await franchiseConfig();
  const next = franchiseConfigSchema.safeParse({ ...current.config, ...patch });
  if (!next.success) throw validationFailed(next.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  if (next.data.maxOwnersPerZone !== current.config.maxOwnersPerZone && !actor.superAdmin) {
    throw forbidden("Only a super-admin can change the maximum owners per area.");
  }
  if (next.data.clockOffsetDays !== 0 && isProduction()) throw forbidden("The test clock cannot be used on gokesari.com.");
  const changed = (Object.keys(next.data) as (keyof FranchiseConfig)[]).filter((k) => JSON.stringify(current.config[k]) !== JSON.stringify(next.data[k]));
  if (!changed.length) return current;
  // Brief 21-Nov §2: what changes the money applies from the next calendar month (IST), never retroactively;
  // everything else (booking open, reminders …) applies now. One save may therefore make two versions.
  const moneyKeys = changed.filter((k) => MONEY_KEYS.includes(k));
  const otherKeys = changed.filter((k) => !MONEY_KEYS.includes(k));
  const nextMonthStart = istMonthBounds(istMonth(new Date())).end;
  const pick = (keys: (keyof FranchiseConfig)[]) => Object.fromEntries(keys.map((k) => [k, next.data[k]])) as Partial<FranchiseConfig>;
  let last: VersionedConfig = current;
  await db.transaction(async (tx) => {
    await tx.execute(sqlLock);
    const insert = async (part: Partial<FranchiseConfig>, effectiveFrom: Date, base: FranchiseConfig) => {
      const maxRows = (await tx.execute(sqlMax)) as unknown as { max: number | null }[];
      const version = Number(maxRows[0]?.max ?? 0) + 1;
      const config = { ...base, ...part };
      await tx.insert(franchiseConfigVersions).values({ version, effectiveFrom, config: config as unknown as Record<string, unknown>, reason, createdBy: actor.id });
      // A version already scheduled after this one carries the change too (it would otherwise undo it).
      const later = await tx.select().from(franchiseConfigVersions).where(gt(franchiseConfigVersions.effectiveFrom, effectiveFrom));
      for (const l of later) {
        if (l.version === version) continue;
        await tx.update(franchiseConfigVersions).set({ config: { ...(l.config as object), ...part } as Record<string, unknown> }).where(eq(franchiseConfigVersions.version, l.version));
      }
      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: AUDIT_ACTIONS.FRANCHISE_CONFIG_CHANGED,
          entityType: "franchise_config",
          entityId: String(version),
          previousValue: { version: current.version, ...Object.fromEntries(Object.keys(part).map((k) => [k, current.config[k as keyof FranchiseConfig]])) },
          newValue: { version, effectiveFrom: effectiveFrom.toISOString(), reason, ...part },
        },
        tx,
      );
      last = { version, effectiveFrom, config: parse(config) };
    };
    if (otherKeys.length) {
      const at = input.effectiveFrom && input.effectiveFrom.getTime() > Date.now() ? input.effectiveFrom : new Date();
      await insert(pick(otherKeys), at, current.config);
    }
    if (moneyKeys.length) {
      const at = input.effectiveFrom && input.effectiveFrom.getTime() > nextMonthStart.getTime() ? input.effectiveFrom : nextMonthStart;
      // Based on the latest version scheduled at or before that moment (so a scheduled change is not lost).
      const [base] = await tx.select().from(franchiseConfigVersions).where(lte(franchiseConfigVersions.effectiveFrom, at)).orderBy(desc(franchiseConfigVersions.effectiveFrom), desc(franchiseConfigVersions.version)).limit(1);
      await insert(pick(moneyKeys), at, parse(base?.config ?? current.config));
    }
  });
  return last;
}

/** Settings that change what is paid: a change takes effect from the next calendar month. */
export const MONEY_KEYS: (keyof FranchiseConfig)[] = ["oneTimeBp", "recurringBaseBp", "bonusMaxBp", "gokesariCommissionBp", "monthlyShopTarget", "expectedBusinessPerShopPaise", "businessSlotPaise", "basePointsPerMainPoint", "bonusBpPerMainPoint", "postLaunchOneTimeBp", "postLaunchRecurringBp"];

/** The bonus settings of a config (src/lib/franchise-bonus.ts). */
export function bonusSettingsOf(c: FranchiseConfig): BonusSettings {
  return {
    onboardingBp: c.oneTimeBp,
    recurringBaseBp: c.recurringBaseBp,
    gokesariCommissionBp: c.gokesariCommissionBp,
    monthlyShopTarget: c.monthlyShopTarget,
    expectedBusinessPerShopPaise: c.expectedBusinessPerShopPaise,
    businessSlotPaise: c.businessSlotPaise,
    basePointsPerMainPoint: c.basePointsPerMainPoint,
    bonusBpPerMainPoint: c.bonusBpPerMainPoint,
    bonusMaxBp: c.bonusMaxBp,
  };
}

const sqlLock = sql`select pg_advisory_xact_lock(hashtext('franchise-config'))`;
const sqlMax = sql`select max(version) as max from franchise_config_versions`;


/** "Now" for franchise dates: real time, shifted by the test clock on the test server only. */
export function franchiseNow(config: Pick<FranchiseConfig, "clockOffsetDays">, real: Date = new Date()): Date {
  if (!config.clockOffsetDays || isProduction()) return real;
  return new Date(real.getTime() + config.clockOffsetDays * 86_400_000);
}
