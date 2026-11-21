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
import { DEFAULT_TIER_DISPLAY, DEFAULT_TIER_SETTINGS, TIER_NAME_CHOICES, parityProblems, type OneTimeRates, type TierDisplay, type TierSettings } from "@/lib/franchise-zones";
import { db, type DbClient } from "@/server/db";
import { franchiseConfigVersions, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const tierRecord = <T extends z.ZodTypeAny>(t: T) => z.object({ PREMIER: t, STANDARD: t, EMERGING: t });

export const franchiseConfigSchema = z
  .object({
    /** Master switch: no booking or payment while false (zones and pages still show). */
    bookingOpen: z.boolean(),
    /** Zone sets shown in the booking flow and API (brief §5.1). */
    zoneSetsEnabled: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1),
    /** Owner, 21-Nov-2026 09.20 IST: the launch-offer (promotional) fee for every zone while the launch offer is open
     * (first 25 franchise dealers); the zone's tier fee is shown beside it as the regular rate. null = no promotion. */
    promoFeePaise: int(100, 1_000_000_000).nullable(),
    /** §5.3: zones whose current fee is provisional can be bought only when this is on (off by default). */
    allowProvisionalSale: z.boolean(),
    /** §5.2: the standard fee, the ±band that is Standard, and the optional min / max fee (null = off). */
    standardFeePaise: int(100, 1_000_000_000),
    standardBandBp: int(0, 5_000),
    feeMinPaise: int(100, 1_000_000_000).nullable(),
    feeMaxPaise: int(100, 1_000_000_000).nullable(),
    /** §5.2: tier display names (one of each pair) and badge colours. */
    tierNames: tierRecord(z.string().min(1).max(30)),
    tierColours: tierRecord(z.string().regex(/^#[0-9a-fA-F]{6}$/)),
    gstRateBp: int(0, 5_000),
    validityMonths: int(1, 60),
    /** The default for new zones; each zone has its own (1 or 2), never below its active franchises. */
    maxOwnersPerZone: int(1, 2),
    reservationHoldMinutes: int(5, 120),
    maxAreasPerBooking: int(1, 50),
    launchMaxOwners: int(0, 10_000),
    launchMaxAreas: int(0, 10_000),
    launchCloseRule: z.enum(["first_limit_reached", "owners_only", "areas_only"]),
    /** Blank (null) by default: after the launch offer closes, booking shows "new terms coming soon". */
    postLaunchRecurringBp: int(0, 10_000).nullable(),
    /** §3.2: the franchise owner's one-time rates — own shop, and override on each team shop. Agent / team-lead
     * rates are the free dealership's (rule dealerTieredCommission), one field each for both models (§3.4). */
    ownerSelfBp: int(0, 10_000),
    ownerOverrideBp: int(0, 10_000),
    /** Recurring share of GoKesari's order commission, and the most a bonus can add (§4). */
    recurringBaseBp: int(0, 10_000),
    bonusMaxBp: int(0, 10_000),
    /** GoKesari's order commission on delivered order value (200 = 2%). */
    gokesariCommissionBp: int(0, 10_000),
    /** Monthly bonus (§4.1): target, expected business per shop, slot, points. */
    monthlyShopTarget: int(0, 100_000),
    expectedBusinessPerShopPaise: int(0, 10_000_000_000),
    businessSlotPaise: int(1, 10_000_000_000),
    basePointsPerMainPoint: int(1, 1_000_000),
    bonusBpPerMainPoint: int(0, 10_000),
    /** §6: a free-team shop in a zone with two active franchises — split 50/50, or to the nearest owner. */
    recurringSplitMode: z.enum(["split", "nearest"]),
    /** Month-end: calculation runs on days 1..calcLastDay, statements on statementDay at statementHourIst. */
    calcLastDay: int(1, 4),
    statementDay: int(2, 5),
    statementHourIst: int(0, 23),
    renewalWindowDays: int(1, 365),
    /** §5.6: owners of a franchise in an Inactive zone are told this many days before expiry. */
    inactiveNoticeDays: int(1, 365),
    tailMode: z.enum(["fixed_end_of_year_3", "years_after_lapse"]),
    tailYears: int(0, 10),
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
  .refine((c) => c.recurringBaseBp + c.bonusMaxBp <= 10_000, { message: "Share plus bonus cannot pass 100%.", path: ["bonusMaxBp"] })
  .refine((c) => c.feeMinPaise == null || c.feeMaxPaise == null || c.feeMinPaise <= c.feeMaxPaise, { message: "The minimum fee cannot be above the maximum.", path: ["feeMinPaise"] })
  .refine((c) => (Object.keys(TIER_NAME_CHOICES) as (keyof typeof TIER_NAME_CHOICES)[]).every((t) => TIER_NAME_CHOICES[t].includes(c.tierNames[t])), { message: "Each tier name must be one of its pair (Premier / Platinum, Standard / Established, Emerging / Developing).", path: ["tierNames"] });

export type FranchiseConfig = z.infer<typeof franchiseConfigSchema>;

/** Brief defaults (final brief 21-Nov-2026 08.06 IST). */
export const FRANCHISE_DEFAULTS: FranchiseConfig = {
  // Owner, 21-Nov-2026 09.20 IST: booking open; Pune, Mumbai (Konkan) and Nashik zones on sale at the ₹1,50,000 launch fee.
  bookingOpen: true,
  zoneSetsEnabled: ["PUN", "MUM", "NSK"],
  promoFeePaise: 15_000_000,
  allowProvisionalSale: false,
  standardFeePaise: DEFAULT_TIER_SETTINGS.standardFeePaise,
  standardBandBp: DEFAULT_TIER_SETTINGS.standardBandBp,
  feeMinPaise: null,
  feeMaxPaise: null,
  tierNames: DEFAULT_TIER_DISPLAY.names,
  tierColours: DEFAULT_TIER_DISPLAY.colours,
  gstRateBp: 1800,
  validityMonths: 12,
  maxOwnersPerZone: 2,
  reservationHoldMinutes: 15,
  maxAreasPerBooking: 10,
  launchMaxOwners: 25,
  launchMaxAreas: 25,
  launchCloseRule: "first_limit_reached",
  postLaunchRecurringBp: null,
  ownerSelfBp: 2500,
  ownerOverrideBp: 500,
  recurringBaseBp: 2500,
  bonusMaxBp: 500,
  gokesariCommissionBp: 200,
  monthlyShopTarget: 60,
  expectedBusinessPerShopPaise: 10_000_000,
  businessSlotPaise: 500_000,
  basePointsPerMainPoint: 100,
  bonusBpPerMainPoint: 100,
  recurringSplitMode: "split",
  calcLastDay: 3,
  statementDay: 4,
  statementHourIst: 10,
  renewalWindowDays: 30,
  inactiveNoticeDays: 30,
  // §4.2: the owner keeps recurring commission on his own team's shops for 2 more years after he stops renewing.
  tailMode: "years_after_lapse",
  tailYears: 2,
  expiryCc: ["ceo@agtci.com"],
  reminderHourIst: 10,
  digestHourIst: 9,
  calcHourIst: 2,
  payoutOnNextWorkingDay: true,
  bankHolidays: [],
  clockOffsetDays: 0,
};

/** The tier settings of a config (src/lib/franchise-zones.ts). */
export const tierSettingsOf = (c: FranchiseConfig): TierSettings => ({ standardFeePaise: c.standardFeePaise, standardBandBp: c.standardBandBp, feeMinPaise: c.feeMinPaise, feeMaxPaise: c.feeMaxPaise });
export const tierDisplayOf = (c: FranchiseConfig): TierDisplay => ({ names: c.tierNames, colours: c.tierColours });

/** The one-time rates of both models (§3): agent / team lead / free dealer from the tiered rule, owner from here. */
export async function oneTimeRates(c: Pick<FranchiseConfig, "ownerSelfBp" | "ownerOverrideBp">): Promise<OneTimeRates> {
  const { getRule } = await import("@/server/services/settings");
  const rule = await getRule("dealerTieredCommission");
  return {
    memberDirectBp: rule.directBp,
    leadOverrideBp: rule.leadOverrideBp,
    dealerSelfBp: rule.directBp,
    // Owner, 21-Nov-2026: the free dealer earns the first override (4%) one level up and the second (3%) two up.
    dealerOverrideBp: rule.overrideByDistance === false ? rule.mainOverrideBp : rule.leadOverrideBp,
    dealerSecondOverrideBp: rule.mainOverrideBp,
    ownerSelfBp: c.ownerSelfBp,
    ownerOverrideBp: c.ownerOverrideBp,
  };
}

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
    .values({ version: 1, effectiveFrom: new Date("2026-11-20T17:20:00Z"), config: FRANCHISE_DEFAULTS as unknown as Record<string, unknown>, reason: "Brief defaults (owner prompts 20/21-Nov-2026)" })
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
  // §3.4: the owner's rates may never be lower than the free dealer's.
  const parity = parityProblems(await oneTimeRates(next.data));
  if (parity.length) throw validationFailed(parity.join(" "));
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
export const MONEY_KEYS: (keyof FranchiseConfig)[] = ["ownerSelfBp", "ownerOverrideBp", "recurringBaseBp", "bonusMaxBp", "gokesariCommissionBp", "monthlyShopTarget", "expectedBusinessPerShopPaise", "businessSlotPaise", "basePointsPerMainPoint", "bonusBpPerMainPoint", "postLaunchRecurringBp", "recurringSplitMode"];

/** The bonus settings of a config (src/lib/franchise-bonus.ts). */
export function bonusSettingsOf(c: FranchiseConfig): BonusSettings {
  return {
    onboardingBp: c.ownerSelfBp,
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
