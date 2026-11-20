/**
 * Franchise commercial configuration (brief §3, §8, §9, §17), versioned with an effective time
 * (franchise_config_versions). A booking, allocation and commission entry remembers the version in force
 * when it was made. Every value is server-side; the client never sends a price or a percentage.
 */
import { desc, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { conflict, forbidden, validationFailed } from "@/lib/errors";
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
    /** Recurring share of GoKesari's actual order commission, and the most a bonus can add. */
    recurringBaseBp: int(0, 10_000),
    bonusMaxBp: int(0, 10_000),
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
  renewalFeePaise: null,
  renewalWindowDays: 30,
  tailMode: "fixed_end_of_year_3",
  tailYears: 3,
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
  const effectiveFrom = input.effectiveFrom ?? new Date();
  const saved = await db.transaction(async (tx) => {
    await tx.execute(sqlLock);
    const maxRows = (await tx.execute(sqlMax)) as unknown as { max: number | null }[];
    const version = Number(maxRows[0]?.max ?? 0) + 1;
    if (version > 1 && effectiveFrom.getTime() < current.effectiveFrom.getTime()) throw conflict("A new version cannot take effect before the one in force.");
    const [row] = await tx
      .insert(franchiseConfigVersions)
      .values({ version, effectiveFrom, config: next.data as unknown as Record<string, unknown>, reason, createdBy: actor.id })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.FRANCHISE_CONFIG_CHANGED,
        entityType: "franchise_config",
        entityId: String(version),
        previousValue: { version: current.version, ...diff(current.config, next.data, "from") },
        newValue: { version, effectiveFrom: effectiveFrom.toISOString(), reason, ...diff(current.config, next.data, "to") },
      },
      tx,
    );
    return row;
  });
  return { version: saved.version, effectiveFrom: saved.effectiveFrom, config: next.data };
}

const sqlLock = sql`select pg_advisory_xact_lock(hashtext('franchise-config'))`;
const sqlMax = sql`select max(version) as max from franchise_config_versions`;

function diff(a: FranchiseConfig, b: FranchiseConfig, side: "from" | "to"): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(b) as (keyof FranchiseConfig)[]) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = side === "from" ? a[k] : b[k];
  }
  return out;
}

/** "Now" for franchise dates: real time, shifted by the test clock on the test server only. */
export function franchiseNow(config: Pick<FranchiseConfig, "clockOffsetDays">, real: Date = new Date()): Date {
  if (!config.clockOffsetDays || isProduction()) return real;
  return new Date(real.getTime() + config.clockOffsetDays * 86_400_000);
}
