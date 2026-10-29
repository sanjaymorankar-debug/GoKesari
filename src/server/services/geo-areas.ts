/**
 * Territory hierarchy (docs/dealer-programme): State → (Region) → District →
 * Taluka/City → Locality, for every state and union territory of India.
 *
 * `geo_areas` (seller database: 0103 seeded Maharashtra with its divisions,
 * districts and Pune's localities; 0113 every other state and UT, each with
 * its PIN prefixes; an admin adds a state's districts as it starts) and
 * `geo_area_pincodes`: a PIN code belongs to the area with the longest
 * matching prefix, so a locality's 6-digit PIN wins over its district's "411".
 * Used for feature-flag districts, dealer territories and coverage reports.
 *
 * Only an ADMIN may add or change areas (checked here). Reads need no role.
 */
import { asc, eq, inArray, sql } from "drizzle-orm";

import { districtShortCode } from "@/lib/indian-states";

import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { upsertRow } from "@/server/db/split/upsert";
import { GEO_LEVELS, geoAreaPincodes, geoAreas, type GeoArea, type GeoLevel, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";

/** The levels a child of each level may have (a state's districts may sit under a region, as in Maharashtra, or directly under it). */
export const CHILD_LEVELS: Record<GeoLevel, readonly GeoLevel[]> = {
  STATE: ["REGION", "DISTRICT"],
  REGION: ["DISTRICT"],
  DISTRICT: ["TALUKA"],
  TALUKA: ["LOCALITY"],
  LOCALITY: [],
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

/** Every state and union territory, by name. */
export async function listStates(): Promise<GeoArea[]> {
  return db.select().from(geoAreas).where(eq(geoAreas.level, "STATE")).orderBy(asc(geoAreas.name));
}

/** A state's districts (directly under it or under one of its regions), by name. */
export async function listDistrictsOf(stateCode: string): Promise<GeoArea[]> {
  return db
    .select()
    .from(geoAreas)
    .where(sql`${geoAreas.level} = 'DISTRICT' and ${geoAreas.code} like ${stateCode.toUpperCase() + "-%"}`)
    .orderBy(asc(geoAreas.name));
}

/**
 * ADMIN: adds a district to a state — directly under it — with a generated
 * short code (unique among districts) and the code "<STATE>-<SHORT>". An
 * existing district of that name in the state is returned as it is.
 */
export async function addDistrict(stateCode: string, name: string, actor: { id: string; role: UserRole }, pincodePrefixes: string[] = []): Promise<GeoArea> {
  const state = await getGeoArea(stateCode.toUpperCase());
  if (!state || state.level !== "STATE") throw notFound("State");
  const clean = name.trim().replace(/\s+/g, " ");
  const same = (await listDistrictsOf(state.code)).find((d) => d.name.toLowerCase() === clean.toLowerCase());
  if (same) return same;
  const taken = new Set((await listDistricts()).map((d) => d.shortCode).filter((c): c is string => Boolean(c)));
  let short: string;
  try {
    short = districtShortCode(clean, taken);
  } catch {
    throw validationFailed("Give the district's name.", { fields: { district: "At least two letters." } });
  }
  return saveGeoArea({ code: `${state.code}-${short}`, name: clean, level: "DISTRICT", parentCode: state.code, shortCode: short, pincodePrefixes }, actor);
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

/**
 * The area used for flags, commission rules and dealer districts: the PIN's
 * district when one is mapped, else its state (e.g. "KA" before Karnataka's
 * districts are added); null when the PIN is not mapped at all.
 */
export async function districtCodeForPincode(pincode: string | null | undefined): Promise<string | null> {
  const place = await areaForPincode(pincode);
  if (!place) return null;
  if (place.district) return place.district.code;
  const chain = await geoAncestry(place.area.code);
  return chain.find((a) => a.level === "STATE")?.code ?? null;
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
  const allowed = CHILD_LEVELS[parent.level];
  if (!allowed.includes(input.level)) {
    throw validationFailed(`A ${GEO_LEVEL_LABELS[parent.level]} holds ${allowed.length ? allowed.map((l) => GEO_LEVEL_LABELS[l]).join(" or ") : "nothing"}.`, {
      fields: { level: "Wrong level for this parent." },
    });
  }
  let shortCode = input.shortCode?.trim().toUpperCase() || null;
  if (input.level === "DISTRICT" && !shortCode) {
    // Generated from the name, unique among districts (it goes into dealer codes).
    const taken = new Set((await listDistricts()).filter((d) => d.code !== code).map((d) => d.shortCode).filter((c): c is string => Boolean(c)));
    shortCode = districtShortCode(name, taken);
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

export interface OpenArea {
  code: string;
  name: string;
  /** null for a state; the state for its districts; the district or city above the rest. */
  parent: string | null;
}

/**
 * The areas a dealer may choose where a feature is open: every state when the
 * flag covers all of India, else the states it names whole and the named
 * districts' states; under each state its districts (all of them for a whole
 * state, only the named ones otherwise), then their cities and localities.
 */
export async function openAreasFor(districtCodes: readonly string[] | null): Promise<OpenArea[]> {
  const [states, districts] = await Promise.all([listStates(), listDistricts()]);
  const named = new Set(districtCodes ?? []);
  const stateOf = (code: string) => code.split("-")[0];
  const out: OpenArea[] = [];
  for (const state of states) {
    if (state.status !== "ACTIVE") continue;
    const whole = districtCodes === null || named.has(state.code);
    const mine = districts.filter((d) => d.status === "ACTIVE" && stateOf(d.code) === state.code && (whole || named.has(d.code)));
    if (!whole && mine.length === 0) continue;
    out.push({ code: state.code, name: state.name, parent: null });
    for (const d of mine) {
      out.push({ code: d.code, name: d.name, parent: state.code });
      for (const city of await listGeoAreas({ parentCode: d.code })) {
        if (city.status !== "ACTIVE") continue;
        out.push({ code: city.code, name: city.name, parent: d.code });
        for (const loc of await listGeoAreas({ parentCode: city.code })) if (loc.status === "ACTIVE") out.push({ code: loc.code, name: loc.name, parent: city.code });
      }
    }
  }
  return out;
}
