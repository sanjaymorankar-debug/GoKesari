/**
 * Territory hierarchy (docs/dealer-programme, step 1):
 * Maharashtra → Region (division) → District → Taluka/City → Locality.
 *
 * `geo_areas` (seller database, seeded by migration 0103 with the state, its
 * divisions and 36 districts, and Pune's cities and first localities) and
 * `geo_area_pincodes`: a PIN code belongs to the area with the longest
 * matching prefix, so a locality's 6-digit PIN wins over its district's "411".
 * Used for feature-flag districts, dealer territories and coverage reports.
 *
 * Only an ADMIN may add or change areas (checked here). Reads need no role.
 */
import { asc, eq, inArray, sql } from "drizzle-orm";

import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { upsertRow } from "@/server/db/split/upsert";
import { GEO_LEVELS, geoAreaPincodes, geoAreas, type GeoArea, type GeoLevel, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";

/** The level a child of each level must have. */
export const CHILD_LEVEL: Record<GeoLevel, GeoLevel | null> = {
  STATE: "REGION",
  REGION: "DISTRICT",
  DISTRICT: "TALUKA",
  TALUKA: "LOCALITY",
  LOCALITY: null,
};

export const GEO_LEVEL_LABELS: Record<GeoLevel, string> = {
  STATE: "State",
  REGION: "Region",
  DISTRICT: "District",
  TALUKA: "Taluka / City",
  LOCALITY: "Locality",
};

const CODE = /^[A-Z][A-Z0-9-]{1,47}$/;
const PIN_PREFIX = /^[1-9][0-9]{0,5}$/;

export async function listDistricts(): Promise<GeoArea[]> {
  return db.select().from(geoAreas).where(eq(geoAreas.level, "DISTRICT")).orderBy(asc(geoAreas.name));
}

export async function listGeoAreas(options: { parentCode?: string; level?: GeoLevel } = {}): Promise<GeoArea[]> {
  return db
    .select()
    .from(geoAreas)
    .where(
      sql`${options.parentCode ? eq(geoAreas.parentCode, options.parentCode) : sql`true`} and ${options.level ? eq(geoAreas.level, options.level) : sql`true`}`,
    )
    .orderBy(asc(geoAreas.name));
}

export async function getGeoArea(code: string): Promise<GeoArea | null> {
  const [row] = await db.select().from(geoAreas).where(eq(geoAreas.code, code)).limit(1);
  return row ?? null;
}

/** The area and all its ancestors, from the area up to the state. */
export async function geoAncestry(code: string): Promise<GeoArea[]> {
  const chain: GeoArea[] = [];
  let next: string | null = code;
  for (let i = 0; next && i < GEO_LEVELS.length; i++) {
    const area = await getGeoArea(next);
    if (!area) break;
    chain.push(area);
    next = area.parentCode;
  }
  return chain;
}

export interface PincodePlace {
  /** The most specific area the PIN maps to. */
  area: GeoArea;
  district: GeoArea | null;
}

/** The area a 6-digit PIN code belongs to (longest prefix), with its district; null when unmapped. */
export async function areaForPincode(pincode: string | null | undefined): Promise<PincodePlace | null> {
  const pin = (pincode ?? "").trim();
  if (!/^[1-9][0-9]{5}$/.test(pin)) return null;
  const prefixes = Array.from({ length: 6 }, (_, i) => pin.slice(0, i + 1));
  const rows = await db
    .select({ prefix: geoAreaPincodes.pincodePrefix, area: geoAreas })
    .from(geoAreaPincodes)
    .innerJoin(geoAreas, eq(geoAreas.code, geoAreaPincodes.areaCode))
    .where(inArray(geoAreaPincodes.pincodePrefix, prefixes));
  const active = rows.filter((r) => r.area.status === "ACTIVE");
  if (active.length === 0) return null;
  active.sort((a, b) => b.prefix.length - a.prefix.length || a.area.code.localeCompare(b.area.code));
  const area = active[0].area;
  const chain = await geoAncestry(area.code);
  return { area, district: chain.find((a) => a.level === "DISTRICT") ?? null };
}

/** The district code for a PIN code, or null when the PIN is not mapped. */
export async function districtCodeForPincode(pincode: string | null | undefined): Promise<string | null> {
  return (await areaForPincode(pincode))?.district?.code ?? null;
}

export interface GeoAreaInput {
  code: string;
  name: string;
  level: GeoLevel;
  parentCode: string;
  shortCode?: string | null;
  status?: "ACTIVE" | "INACTIVE";
  pincodePrefixes?: string[];
}

/**
 * Adds or updates an area below an existing parent (ADMIN only). The level
 * must be the one below the parent's; districts need a 2–4 letter short code,
 * unique among districts. PIN prefixes given here are added (none removed).
 */
export async function saveGeoArea(input: GeoAreaInput, actor: { id: string; role: UserRole }): Promise<GeoArea> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can change areas.");
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  if (!CODE.test(code)) throw validationFailed("Use capital letters, digits and dashes for the code.", { fields: { code: "Invalid code." } });
  if (name.length < 2 || name.length > 80) throw validationFailed("Give the area a name.", { fields: { name: "2 to 80 characters." } });
  const parent = await getGeoArea(input.parentCode);
  if (!parent) throw notFound("Parent area");
  if (CHILD_LEVEL[parent.level] !== input.level) {
    throw validationFailed(`A ${GEO_LEVEL_LABELS[parent.level]} holds ${CHILD_LEVEL[parent.level] ? GEO_LEVEL_LABELS[CHILD_LEVEL[parent.level]!] : "nothing"}.`, {
      fields: { level: "Wrong level for this parent." },
    });
  }
  const shortCode = input.shortCode?.trim().toUpperCase() || null;
  if (input.level === "DISTRICT" && !shortCode) {
    throw validationFailed("A district needs a short code (it goes into dealer codes).", { fields: { shortCode: "2 to 4 capital letters." } });
  }
  if (shortCode && !/^[A-Z]{2,4}$/.test(shortCode)) throw validationFailed("Short code: 2 to 4 capital letters.", { fields: { shortCode: "2 to 4 capital letters." } });
  const prefixes = [...new Set((input.pincodePrefixes ?? []).map((p) => p.trim()).filter(Boolean))];
  const bad = prefixes.filter((p) => !PIN_PREFIX.test(p));
  if (bad.length) throw validationFailed(`Not a PIN code prefix: ${bad.join(", ")}.`, { fields: { pincodePrefixes: "1 to 6 digits, not starting with 0." } });

  const before = await getGeoArea(code);
  return db.transaction(async (tx) => {
    const row = {
      code,
      name,
      level: input.level,
      parentCode: parent.code,
      shortCode: input.level === "DISTRICT" ? shortCode : null,
      status: input.status ?? before?.status ?? "ACTIVE",
      updatedAt: new Date(),
    };
    await upsertRow(tx, geoAreas, { keys: [geoAreas.code], values: row, set: row });
    for (const prefix of prefixes) {
      // geo_area_pincodes has one unique key (its primary key), so a target-less DO NOTHING is safe on the split layout.
      await tx.insert(geoAreaPincodes).values({ pincodePrefix: prefix, areaCode: code }).onConflictDoNothing();
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.GEO_AREA_SAVED,
        entityType: "geo_area",
        entityId: code,
        previousValue: before ?? null,
        newValue: { ...row, pincodePrefixes: prefixes },
      },
      tx,
    );
    const [saved] = await tx.select().from(geoAreas).where(eq(geoAreas.code, code));
    return saved;
  });
}
