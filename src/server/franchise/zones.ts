/**
 * Franchise zones (owner's final brief 21-Nov-2026 08.06 IST, §5): zone sets, the 50 Pune zones (one cluster each),
 * the area master and each shop's area over time, business figures → tier and fee (import, preview, publish),
 * zone status (Admin control, scheduled changes, Reserved expiry, Sold Out set by the system), the booking-page
 * views and map data. Owners live on franchise_allocations, never on the zone.
 */
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { OCCUPYING_STATUSES, ZONE_STATUS_LABELS, boundaryRing, distanceM, formatIst, polygonsFromGeoJson, validateBoundary, zoneBadge, type LatLng, type ZoneBadge, type ZoneStatus, type ZoneTier } from "@/lib/franchise";
import { averageOf, tierFor, vsAverage, zoneDescription } from "@/lib/franchise-zones";
import { db, type DbClient } from "@/server/db";
import {
  dealers,
  franchiseAllocations,
  franchiseAreaZoneHistory,
  franchiseAreas,
  franchiseNotificationLog,
  franchiseShopAreaPeriods,
  franchiseZoneBoundaries,
  franchiseZoneBusiness,
  franchiseZoneFeeVersions,
  franchiseZoneSets,
  franchiseZoneStatusHistory,
  franchiseZones,
  type FranchiseArea,
  type FranchiseZone,
  type FranchiseZoneBoundary,
  type FranchiseZoneFeeVersion,
  type UserRole,
} from "@/server/db/schema";
import { sendEmail } from "@/server/email/transport";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify } from "@/server/services/notifications";
import { franchiseConfig, tierDisplayOf, tierSettingsOf } from "./config";

export interface Actor {
  id: string;
  role: UserRole;
}

const requireAdmin = (actor: Actor, what: string) => {
  if (actor.role !== "ADMIN") throw forbidden(`Only an admin can ${what}.`);
};
const requireReason = (reason: string | null | undefined): string => {
  const r = (reason ?? "").trim();
  if (r.length < 5) throw validationFailed("Give a reason of at least 5 characters.");
  return r.slice(0, 500);
};

/* ================================================================ views */

export interface ZoneView {
  zoneId: string;
  zoneSetCode: string;
  setName: string;
  clusterNo: number;
  name: string;
  region: string;
  civicBody: string | null;
  reason: string;
  status: ZoneStatus;
  statusLabel: string;
  statusReason: string | null;
  badge: ZoneBadge;
  maxOwners: number;
  /** Slots taken by an active franchise or a checkout hold. */
  occupied: number;
  /** Active (or suspended) franchises. */
  active: number;
  slotsFree: number;
  reservedForDealerId: string | null;
  reservedUntil: Date | null;
  tier: ZoneTier | null;
  tierName: string | null;
  tierColour: string | null;
  diffBp: number;
  vsAverage: string;
  metric: "INDEX" | "ANNUAL_CR" | null;
  value: number | null;
  source: string | null;
  asOf: string | null;
  /** The tier fee's figures are provisional (post-launch / regular rate). */
  provisional: boolean;
  /** What a booking pays now: the launch-offer fee while it is open, else the regular (tier) fee. */
  feePaise: number | null;
  /** The zone's regular annual fee from its tier (shown beside the launch offer). */
  regularFeePaise: number | null;
  /** The launch-offer fee while the launch offer is open, else null. */
  promoFeePaise: number | null;
  feeVersionId: string | null;
  description: string;
  areas: string[];
  centre: LatLng | null;
  /** Anyone can buy it now (status Available, a slot free, fee final or provisional sale allowed). Reserved: see canBuy. */
  forSale: boolean;
  isTest: boolean;
}

/** Every zone of the enabled zone sets with its tier, fee, status and slots. Test zones only when asked (admins). */
export async function zoneViews(options: { includeTest?: boolean; zoneIds?: string[]; includeInactive?: boolean; client?: DbClient } = {}): Promise<ZoneView[]> {
  const client = options.client ?? db;
  const { config } = await franchiseConfig(client);
  const display = tierDisplayOf(config);
  const promoFeePaise = await promoFeeNow(client, config.promoFeePaise);
  const rows = await client
    .select({ z: franchiseZones, setName: franchiseZoneSets.name })
    .from(franchiseZones)
    .innerJoin(franchiseZoneSets, eq(franchiseZoneSets.code, franchiseZones.zoneSetCode))
    .where(and(inArray(franchiseZones.zoneSetCode, config.zoneSetsEnabled), options.zoneIds?.length ? inArray(franchiseZones.zoneId, options.zoneIds) : undefined))
    .orderBy(asc(franchiseZones.zoneSetCode), asc(franchiseZones.clusterNo));
  const ids = rows.map((r) => r.z.zoneId);
  if (!ids.length) return [];
  const [fees, business, allocs, areas] = await Promise.all([
    client.select().from(franchiseZoneFeeVersions).where(and(inArray(franchiseZoneFeeVersions.zoneId, ids), isNull(franchiseZoneFeeVersions.supersededAt))),
    client.select().from(franchiseZoneBusiness).where(and(inArray(franchiseZoneBusiness.zoneId, ids), eq(franchiseZoneBusiness.status, "PUBLISHED"))),
    client.select({ zoneId: franchiseAllocations.zoneId, status: franchiseAllocations.status }).from(franchiseAllocations).where(and(inArray(franchiseAllocations.zoneId, ids), inArray(franchiseAllocations.status, [...OCCUPYING_STATUSES]))),
    client.select({ zoneId: franchiseAreas.zoneId, name: franchiseAreas.name, lat: franchiseAreas.lat, lng: franchiseAreas.lng, areaNo: franchiseAreas.areaNo }).from(franchiseAreas).where(inArray(franchiseAreas.zoneId, ids)).orderBy(asc(franchiseAreas.areaNo)),
  ]);
  const feeBy = new Map(fees.map((f) => [f.zoneId, f]));
  const busBy = new Map(business.map((b) => [b.zoneId, b]));
  const out: ZoneView[] = [];
  for (const { z, setName } of rows) {
    if (z.isTest && !options.includeTest) continue;
    if (z.status === "INACTIVE" && !options.includeInactive) continue;
    const fee = feeBy.get(z.zoneId) ?? null;
    const bus = busBy.get(z.zoneId) ?? null;
    const zoneAllocs = allocs.filter((a) => a.zoneId === z.zoneId);
    const occupied = zoneAllocs.length;
    const active = zoneAllocs.filter((a) => a.status === "ACTIVE" || a.status === "SUSPENDED").length;
    const zoneAreas = areas.filter((a) => a.zoneId === z.zoneId);
    const pts = zoneAreas.filter((a) => a.lat != null && a.lng != null).map((a) => [Number(a.lat), Number(a.lng)] as LatLng);
    const centre: LatLng | null = pts.length ? [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length] : null;
    const slotsFree = Math.max(0, z.maxOwners - occupied);
    const provisional = fee?.provisional ?? true;
    out.push({
      zoneId: z.zoneId,
      zoneSetCode: z.zoneSetCode,
      setName,
      clusterNo: z.clusterNo,
      name: z.name,
      region: z.region,
      civicBody: z.civicBody,
      reason: z.reason,
      status: z.status,
      statusLabel: ZONE_STATUS_LABELS[z.status],
      statusReason: z.statusReason,
      badge: zoneBadge(z.status, z.maxOwners, occupied),
      maxOwners: z.maxOwners,
      occupied,
      active,
      slotsFree,
      reservedForDealerId: z.status === "RESERVED" ? z.reservedForDealerId : null,
      reservedUntil: z.status === "RESERVED" ? z.reservedUntil : null,
      tier: fee?.tier ?? null,
      tierName: fee ? display.names[fee.tier] : null,
      tierColour: fee ? display.colours[fee.tier] : null,
      diffBp: fee?.diffBp ?? 0,
      vsAverage: fee ? vsAverage(fee.diffBp) : "—",
      metric: bus?.metric ?? null,
      value: bus ? Number(bus.value) : null,
      source: bus?.source ?? null,
      asOf: bus?.asOf ?? null,
      provisional,
      feePaise: z.isTest ? (fee ? Number(fee.feePaise) : null) : (promoFeePaise ?? (fee ? Number(fee.feePaise) : null)),
      regularFeePaise: fee ? Number(fee.feePaise) : null,
      promoFeePaise: z.isTest ? null : promoFeePaise,
      feeVersionId: fee?.id ?? null,
      description: fee ? zoneDescription({ tier: fee.tier, diffBp: fee.diffBp, reason: z.reason, feePaise: Number(fee.feePaise), setName, display, promoFeePaise: z.isTest ? null : promoFeePaise }) : z.reason,
      areas: zoneAreas.map((a) => a.name),
      centre,
      // The launch-offer fee is fixed, so it can be sold while the regular rate is still provisional.
      forSale: z.status === "AVAILABLE" && slotsFree > 0 && !!fee && (promoFeePaise != null || !provisional || config.allowProvisionalSale),
      isTest: z.isTest,
    });
  }
  return out;
}

export async function zoneView(zoneId: string, options: { includeTest?: boolean } = {}): Promise<ZoneView> {
  const [v] = await zoneViews({ zoneIds: [zoneId], includeTest: options.includeTest, includeInactive: options.includeTest });
  if (!v) throw notFound("Zone");
  return v;
}

/**
 * The launch-offer fee while the launch offer is open (owner, 21-Nov-2026 09.20 IST: ₹1,50,000 for every zone), or
 * null. The offer closes for good when its 25-dealer limit is reached (franchise_campaigns.closed_at).
 */
export async function promoFeeNow(client: DbClient, promoFeePaise: number | null): Promise<number | null> {
  if (promoFeePaise == null) return null;
  const rows = (await client.execute(sql`select closed_at from franchise_campaigns where code = 'LAUNCH'`)) as unknown as { closed_at: Date | null }[];
  return rows[0]?.closed_at ? null : promoFeePaise;
}

/** Whether `dealerId` may buy the zone now, and why not. */
export function saleProblem(z: ZoneView, dealerId: string | null, now: Date, allowProvisionalSale: boolean): string | null {
  if (z.status === "RESERVED") {
    if (!dealerId || z.reservedForDealerId !== dealerId || (z.reservedUntil && z.reservedUntil.getTime() < now.getTime())) return `${z.zoneId} is reserved for another dealer.`;
  } else if (z.status !== "AVAILABLE") {
    return `${z.zoneId} is ${ZONE_STATUS_LABELS[z.status].toLowerCase()} — it cannot be bought now.`;
  }
  if (z.slotsFree <= 0) return `${z.zoneId} is sold out.`;
  if (z.feePaise == null) return `${z.zoneId} has no fee yet.`;
  if (z.provisional && z.promoFeePaise == null && !allowProvisionalSale) return "Fees being finalised";
  return null;
}

export interface ZoneFilter {
  region?: string;
  tier?: ZoneTier | "ALL";
  /** "available": a slot can be bought now; "1": exactly one slot left. */
  slots?: "available" | "1" | "any";
  feeMinPaise?: number;
  feeMaxPaise?: number;
  status?: ZoneStatus | "ALL";
  q?: string;
}

export function filterZones(zones: ZoneView[], f: ZoneFilter): ZoneView[] {
  return zones.filter((z) => {
    if (f.region && f.region !== "ALL" && z.region !== f.region) return false;
    if (f.tier && f.tier !== "ALL" && z.tier !== f.tier) return false;
    if (f.status && f.status !== "ALL" && z.status !== f.status) return false;
    if (f.slots === "available" && !(z.status === "AVAILABLE" && z.slotsFree > 0)) return false;
    if (f.slots === "1" && z.slotsFree !== 1) return false;
    if (f.feeMinPaise != null && (z.feePaise ?? 0) < f.feeMinPaise) return false;
    if (f.feeMaxPaise != null && (z.feePaise ?? Number.MAX_SAFE_INTEGER) > f.feeMaxPaise) return false;
    if (f.q) {
      const hay = `${z.zoneId} ${z.name} ${z.region} ${z.areas.join(" ")} ${z.reason}`.toLowerCase();
      if (!hay.includes(f.q.toLowerCase().trim())) return false;
    }
    return true;
  });
}

/** Regions and tiers present (for the booking-page filters). */
export function zoneFacets(zones: ZoneView[]): { regions: string[]; tiers: { tier: ZoneTier; name: string; colour: string; count: number }[] } {
  const regions = [...new Set(zones.map((z) => z.region))];
  const tiers = (["PREMIER", "STANDARD", "EMERGING"] as ZoneTier[]).map((tier) => {
    const one = zones.find((z) => z.tier === tier);
    return { tier, name: one?.tierName ?? tier, colour: one?.tierColour ?? "#666666", count: zones.filter((z) => z.tier === tier).length };
  });
  return { regions, tiers };
}

/* ================================================================ areas (§5.1) */

export interface AreaView {
  id: string;
  areaNo: number;
  name: string;
  region: string;
  civicBody: string | null;
  zoneId: string | null;
  zoneName: string | null;
  pincodes: string[];
  lat: number | null;
  lng: number | null;
  locationSource: "APPROXIMATE" | "ADMIN";
}

export async function listAreas(options: { zoneSetCode?: string; zoneId?: string | null; includeTest?: boolean; client?: DbClient } = {}): Promise<AreaView[]> {
  const client = options.client ?? db;
  const rows = await client
    .select({ a: franchiseAreas, zoneName: franchiseZones.name })
    .from(franchiseAreas)
    .leftJoin(franchiseZones, eq(franchiseZones.zoneId, franchiseAreas.zoneId))
    .where(and(options.zoneSetCode ? eq(franchiseAreas.zoneSetCode, options.zoneSetCode) : undefined, options.zoneId !== undefined ? (options.zoneId === null ? isNull(franchiseAreas.zoneId) : eq(franchiseAreas.zoneId, options.zoneId)) : undefined, options.includeTest ? undefined : eq(franchiseAreas.isTest, false)))
    .orderBy(asc(franchiseAreas.zoneSetCode), asc(franchiseAreas.areaNo));
  return rows.map(({ a, zoneName }) => areaView(a, zoneName));
}

const areaView = (a: FranchiseArea, zoneName: string | null): AreaView => ({
  id: a.id,
  areaNo: a.areaNo,
  name: a.name,
  region: a.region,
  civicBody: a.civicBody,
  zoneId: a.zoneId,
  zoneName,
  pincodes: a.pincodes,
  lat: a.lat != null ? Number(a.lat) : null,
  lng: a.lng != null ? Number(a.lng) : null,
  locationSource: a.locationSource,
});

/**
 * Areas to suggest at shop registration (§5.1): those whose PIN code matches first, then the nearest by distance
 * from the shop's location. The user always confirms one. Unzoned areas are included (free teams may register there).
 */
export async function suggestAreas(input: { lat?: number | null; lng?: number | null; pincode?: string | null; limit?: number }, client: DbClient = db): Promise<(AreaView & { distanceM: number | null; pinMatch: boolean })[]> {
  const all = await listAreas({ client });
  const pin = (input.pincode ?? "").trim();
  const here: LatLng | null = input.lat != null && input.lng != null && Number.isFinite(Number(input.lat)) && Number.isFinite(Number(input.lng)) ? [Number(input.lat), Number(input.lng)] : null;
  const scored = all.map((a) => ({ ...a, pinMatch: !!pin && a.pincodes.includes(pin), distanceM: here && a.lat != null && a.lng != null ? Math.round(distanceM(here, [a.lat, a.lng])) : null }));
  scored.sort((x, y) => Number(y.pinMatch) - Number(x.pinMatch) || (x.distanceM ?? Number.MAX_SAFE_INTEGER) - (y.distanceM ?? Number.MAX_SAFE_INTEGER) || x.areaNo - y.areaNo);
  const near = here ? scored.filter((a) => a.pinMatch || (a.distanceM != null && a.distanceM <= 25_000)) : scored.filter((a) => a.pinMatch);
  return near.slice(0, input.limit ?? 8);
}

export async function areaById(areaId: string, client: DbClient = db): Promise<FranchiseArea> {
  const [a] = await client.select().from(franchiseAreas).where(eq(franchiseAreas.id, areaId));
  if (!a) throw validationFailed("Choose the shop's area from the list.");
  return a;
}

/** The shop's area and zone at `at` (default now); null when it has none recorded. */
export async function shopAreaAt(shopId: string, at: Date = new Date(), client: DbClient = db): Promise<{ areaId: string; zoneId: string | null } | null> {
  const [p] = await client
    .select({ areaId: franchiseShopAreaPeriods.areaId, zoneId: franchiseShopAreaPeriods.zoneId })
    .from(franchiseShopAreaPeriods)
    .where(and(eq(franchiseShopAreaPeriods.shopId, shopId), lte(franchiseShopAreaPeriods.validFrom, at), or(isNull(franchiseShopAreaPeriods.validTo), gt(franchiseShopAreaPeriods.validTo, at))))
    .orderBy(desc(franchiseShopAreaPeriods.validFrom))
    .limit(1);
  return p ?? null;
}

/**
 * Records a shop's area (registration, or a correction by an admin / operator — §5.1). A correction closes the open
 * period now and opens a new one, so commission earned before the change keeps the old zone. Idempotent for the
 * same area. Returns the zone.
 */
export async function setShopArea(client: DbClient, shopId: string, areaId: string, input: { source: "REGISTRATION" | "ADMIN" | "OPERATOR" | "BACKFILL"; reason?: string | null; actor?: Actor | null; at?: Date }): Promise<string | null> {
  const area = await areaById(areaId, client);
  const at = input.at ?? new Date();
  const [open] = await client.select().from(franchiseShopAreaPeriods).where(and(eq(franchiseShopAreaPeriods.shopId, shopId), isNull(franchiseShopAreaPeriods.validTo))).for("update");
  if (open && open.areaId === areaId && open.zoneId === area.zoneId) return area.zoneId;
  if (open) {
    if (input.source === "REGISTRATION") return open.zoneId; // a registration never overwrites a correction
    await client.update(franchiseShopAreaPeriods).set({ validTo: at }).where(eq(franchiseShopAreaPeriods.id, open.id));
  }
  await client.insert(franchiseShopAreaPeriods).values({ shopId, areaId, zoneId: area.zoneId, validFrom: at, source: input.source, reason: input.reason ?? null, setBy: input.actor?.id ?? null });
  if (open || input.source !== "REGISTRATION") {
    await recordAudit(
      { actorId: input.actor?.id ?? null, actorRole: input.actor?.role ?? null, action: AUDIT_ACTIONS.FRANCHISE_ATTRIBUTION_CHANGED, entityType: "shop", entityId: shopId, previousValue: open ? { areaId: open.areaId, zoneId: open.zoneId } : null, newValue: { areaId, area: area.name, zoneId: area.zoneId, source: input.source, reason: input.reason ?? null } },
      client,
    );
  }
  return area.zoneId;
}

/** Admin / operator correction of a shop's area (audited; affects only commission earned after the change). */
export async function correctShopArea(shopId: string, areaId: string, reason: string, actor: Actor): Promise<string | null> {
  if (actor.role !== "ADMIN" && actor.role !== "OPERATOR") throw forbidden("Only an admin or operator can correct a shop's area.");
  const why = requireReason(reason);
  return db.transaction((tx) => setShopArea(tx, shopId, areaId, { source: actor.role === "ADMIN" ? "ADMIN" : "OPERATOR", reason: why, actor }));
}

/**
 * Moves an area to another zone (or Unzoned): audited, and every shop in the area gets a new period from now, so
 * commission before the change keeps the old zone.
 */
export async function remapArea(areaId: string, zoneId: string | null, reason: string, actor: Actor): Promise<void> {
  requireAdmin(actor, "change an area's zone");
  const why = requireReason(reason);
  await db.transaction(async (tx) => {
    const [area] = await tx.select().from(franchiseAreas).where(eq(franchiseAreas.id, areaId)).for("update");
    if (!area) throw notFound("Area");
    if (zoneId) {
      const [z] = await tx.select().from(franchiseZones).where(eq(franchiseZones.zoneId, zoneId));
      if (!z || z.zoneSetCode !== area.zoneSetCode) throw validationFailed("Choose a zone of the same zone set.");
    }
    if (area.zoneId === zoneId) return;
    const now = new Date();
    await tx.update(franchiseAreas).set({ zoneId, updatedAt: now }).where(eq(franchiseAreas.id, areaId));
    await tx.insert(franchiseAreaZoneHistory).values({ areaId, oldZoneId: area.zoneId, newZoneId: zoneId, reason: why, changedBy: actor.id });
    const open = await tx.select().from(franchiseShopAreaPeriods).where(and(eq(franchiseShopAreaPeriods.areaId, areaId), isNull(franchiseShopAreaPeriods.validTo)));
    for (const p of open) {
      await tx.update(franchiseShopAreaPeriods).set({ validTo: now }).where(eq(franchiseShopAreaPeriods.id, p.id));
      await tx.insert(franchiseShopAreaPeriods).values({ shopId: p.shopId, areaId, zoneId, validFrom: now, source: "ADMIN", reason: `area moved: ${why}`, setBy: actor.id });
    }
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_ZONE_CHANGED, entityType: "franchise_area", entityId: areaId, previousValue: { zoneId: area.zoneId }, newValue: { zoneId, reason: why, shopsMoved: open.length } }, tx);
  });
}

/** Admin edit of an area's map point and PIN codes (the registration suggestion only). */
export async function updateAreaLocation(areaId: string, input: { lat: number; lng: number; pincodes: string[] }, actor: Actor): Promise<void> {
  requireAdmin(actor, "edit an area");
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng) || Math.abs(input.lat) > 90 || Math.abs(input.lng) > 180) throw validationFailed("Give a valid latitude and longitude.");
  const pins = [...new Set(input.pincodes.map((p) => p.trim()).filter(Boolean))];
  if (pins.some((p) => !/^[1-9][0-9]{5}$/.test(p))) throw validationFailed("PIN codes are 6 digits.");
  await db.update(franchiseAreas).set({ lat: input.lat, lng: input.lng, pincodes: pins, locationSource: "ADMIN", updatedAt: new Date() }).where(eq(franchiseAreas.id, areaId));
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_ZONE_CHANGED, entityType: "franchise_area", entityId: areaId, newValue: input });
}

/* ================================================================ business → tier and fee (§5.2, §5.3) */

export interface FeePreviewRow {
  zoneId: string;
  name: string;
  oldMetric: string | null;
  oldValue: number | null;
  oldTier: ZoneTier | null;
  oldFeePaise: number | null;
  oldProvisional: boolean;
  newMetric: string;
  newValue: number;
  source: string;
  asOf: string;
  newDiffBp: number;
  vsAverage: string;
  newTier: ZoneTier;
  newFeePaise: number;
  changed: boolean;
}

export interface FeePreview {
  batchId: string | null;
  zoneSetCode: string;
  average: number;
  rows: FeePreviewRow[];
  counts: Record<ZoneTier, number>;
}

/** Zones of a set that count for the average: not Inactive, not test. */
async function activeZonesOf(client: DbClient, zoneSetCode: string): Promise<FranchiseZone[]> {
  return client.select().from(franchiseZones).where(and(eq(franchiseZones.zoneSetCode, zoneSetCode), eq(franchiseZones.isTest, false), sql`${franchiseZones.status} <> 'INACTIVE'`)).orderBy(asc(franchiseZones.clusterNo));
}

/**
 * Imports actual annual business per zone (§5.3: zone code, ₹ Cr, source, as-of date) as a DRAFT batch and returns
 * the preview. The import must cover every active zone of the set (the average is over all of them, in one unit).
 */
export async function importZoneBusiness(csvText: string, actor: Actor): Promise<FeePreview> {
  requireAdmin(actor, "import zone business");
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw validationFailed("The file needs a header row and one row per zone.");
  const head = splitCsv(lines[0]).map((h) => h.toLowerCase());
  const col = (names: string[]) => head.findIndex((h) => names.some((n) => h.includes(n)));
  const ci = { zone: col(["zone"]), value: col(["cr", "business"]), source: col(["source"]), asOf: col(["as", "date"]) };
  if (ci.zone < 0 || ci.value < 0 || ci.source < 0 || ci.asOf < 0) throw validationFailed("Columns needed: zone code, annual business (₹ Cr), source, as-of date.");
  const parsed = lines.slice(1).map((l, i) => {
    const c = splitCsv(l);
    const value = Number(String(c[ci.value] ?? "").replace(/[₹,\s]/g, ""));
    const asOf = String(c[ci.asOf] ?? "").trim();
    if (!Number.isFinite(value) || value < 0) throw validationFailed(`Row ${i + 2}: the business figure is not a number.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw validationFailed(`Row ${i + 2}: the as-of date must be YYYY-MM-DD.`);
    const source = String(c[ci.source] ?? "").trim();
    if (!source) throw validationFailed(`Row ${i + 2}: give the data source.`);
    return { zoneId: String(c[ci.zone] ?? "").trim().toUpperCase(), value, source: source.slice(0, 200), asOf };
  });
  const ids = parsed.map((p) => p.zoneId);
  if (new Set(ids).size !== ids.length) throw validationFailed("A zone appears twice in the file.");
  const zones = await db.select().from(franchiseZones).where(inArray(franchiseZones.zoneId, ids));
  if (zones.length !== ids.length) throw validationFailed(`Unknown zone codes: ${ids.filter((id) => !zones.some((z) => z.zoneId === id)).join(", ")}.`);
  const sets = [...new Set(zones.map((z) => z.zoneSetCode))];
  if (sets.length !== 1) throw validationFailed("Import one zone set at a time.");
  const active = await activeZonesOf(db, sets[0]);
  const missing = active.filter((z) => !ids.includes(z.zoneId)).map((z) => z.zoneId);
  if (missing.length) throw validationFailed(`The import must cover every active zone of the set; missing: ${missing.join(", ")}.`);
  const batchId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.update(franchiseZoneBusiness).set({ status: "DISCARDED" }).where(and(inArray(franchiseZoneBusiness.zoneId, ids), eq(franchiseZoneBusiness.status, "DRAFT")));
    await tx.insert(franchiseZoneBusiness).values(parsed.map((p) => ({ zoneId: p.zoneId, batchId, metric: "ANNUAL_CR" as const, value: p.value, source: p.source, asOf: p.asOf, provisional: false, status: "DRAFT" as const, createdBy: actor.id })));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_ZONE_CHANGED, entityType: "franchise_zone_business", entityId: batchId, newValue: { imported: parsed.length, zoneSet: sets[0] } }, tx);
  });
  return previewFees(sets[0], batchId);
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Old vs new for every active zone of the set (§5.3 preview): with a batch, its figures; without one, the published
 * figures under the current tier settings (a recalculation after the standard fee / band / min-max changed).
 */
export async function previewFees(zoneSetCode: string, batchId: string | null = null, client: DbClient = db): Promise<FeePreview> {
  const { config } = await franchiseConfig(client);
  const zones = await activeZonesOf(client, zoneSetCode);
  const ids = zones.map((z) => z.zoneId);
  if (!ids.length) throw validationFailed("The zone set has no active zones.");
  const [published, drafts, fees] = await Promise.all([
    client.select().from(franchiseZoneBusiness).where(and(inArray(franchiseZoneBusiness.zoneId, ids), eq(franchiseZoneBusiness.status, "PUBLISHED"))),
    batchId ? client.select().from(franchiseZoneBusiness).where(and(eq(franchiseZoneBusiness.batchId, batchId), eq(franchiseZoneBusiness.status, "DRAFT"))) : Promise.resolve([]),
    client.select().from(franchiseZoneFeeVersions).where(and(inArray(franchiseZoneFeeVersions.zoneId, ids), isNull(franchiseZoneFeeVersions.supersededAt))),
  ]);
  if (batchId && !drafts.length) throw notFound("Import batch");
  const source = new Map((batchId ? drafts : published).map((b) => [b.zoneId, b]));
  const missing = ids.filter((id) => !source.has(id));
  if (missing.length) throw validationFailed(`No business figure for: ${missing.join(", ")}.`);
  const metrics = new Set([...source.values()].map((b) => b.metric));
  if (metrics.size > 1) throw validationFailed("The zones' figures are in different units; import ₹ Cr for every active zone.");
  const average = averageOf(ids.map((id) => Number(source.get(id)!.value)));
  const settings = tierSettingsOf(config);
  const counts: Record<ZoneTier, number> = { PREMIER: 0, STANDARD: 0, EMERGING: 0 };
  const rows = zones.map((z) => {
    const b = source.get(z.zoneId)!;
    const old = fees.find((f) => f.zoneId === z.zoneId) ?? null;
    const oldBus = published.find((p) => p.zoneId === z.zoneId) ?? null;
    const t = tierFor(Number(b.value), average, settings);
    counts[t.tier]++;
    return {
      zoneId: z.zoneId,
      name: z.name,
      oldMetric: oldBus?.metric ?? null,
      oldValue: oldBus ? Number(oldBus.value) : null,
      oldTier: old?.tier ?? null,
      oldFeePaise: old ? Number(old.feePaise) : null,
      oldProvisional: old?.provisional ?? true,
      newMetric: b.metric,
      newValue: Number(b.value),
      source: b.source,
      asOf: b.asOf,
      newDiffBp: t.diffBp,
      vsAverage: vsAverage(t.diffBp),
      newTier: t.tier,
      newFeePaise: t.feePaise,
      changed: !old || old.tier !== t.tier || Number(old.feePaise) !== t.feePaise || (old.provisional && !b.provisional),
    };
  });
  return { batchId, zoneSetCode, average, rows, counts };
}

/**
 * Publishes a preview (§5.3): the batch's figures become the published ones and every zone gets a new fee version.
 * Active franchises keep the fee they paid (franchise_allocations.fee_paise); new bookings and renewals use the new one.
 */
export async function publishFees(zoneSetCode: string, batchId: string | null, reason: string, actor: Actor): Promise<FeePreview> {
  requireAdmin(actor, "publish zone fees");
  const why = requireReason(reason);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('franchise-fees'))`);
    const preview = await previewFees(zoneSetCode, batchId, tx);
    const now = new Date();
    const ids = preview.rows.map((r) => r.zoneId);
    let businessIds = new Map<string, string>();
    if (batchId) {
      await tx.update(franchiseZoneBusiness).set({ status: "SUPERSEDED" }).where(and(inArray(franchiseZoneBusiness.zoneId, ids), eq(franchiseZoneBusiness.status, "PUBLISHED")));
      const pub = await tx.update(franchiseZoneBusiness).set({ status: "PUBLISHED", publishedAt: now, publishedBy: actor.id }).where(and(eq(franchiseZoneBusiness.batchId, batchId), eq(franchiseZoneBusiness.status, "DRAFT"))).returning();
      businessIds = new Map(pub.map((b) => [b.zoneId, b.id]));
    } else {
      const pub = await tx.select().from(franchiseZoneBusiness).where(and(inArray(franchiseZoneBusiness.zoneId, ids), eq(franchiseZoneBusiness.status, "PUBLISHED")));
      businessIds = new Map(pub.map((b) => [b.zoneId, b.id]));
    }
    const provisional = new Map((await tx.select({ id: franchiseZoneBusiness.id, provisional: franchiseZoneBusiness.provisional }).from(franchiseZoneBusiness).where(inArray(franchiseZoneBusiness.id, [...businessIds.values()]))).map((b) => [b.id, b.provisional]));
    await tx.update(franchiseZoneFeeVersions).set({ supersededAt: now }).where(and(inArray(franchiseZoneFeeVersions.zoneId, ids), isNull(franchiseZoneFeeVersions.supersededAt)));
    const zones = await tx.select().from(franchiseZones).where(inArray(franchiseZones.zoneId, ids));
    for (const r of preview.rows) {
      const businessId = businessIds.get(r.zoneId) ?? null;
      await tx.insert(franchiseZoneFeeVersions).values({
        zoneId: r.zoneId,
        businessId,
        tier: r.newTier,
        value: r.newValue,
        average: preview.average,
        diffBp: r.newDiffBp,
        feePaise: r.newFeePaise,
        reason: zones.find((z) => z.zoneId === r.zoneId)?.reason ?? "",
        provisional: businessId ? (provisional.get(businessId) ?? false) : false,
        effectiveFrom: now,
        createdBy: actor.id,
      });
    }
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_ZONE_CHANGED, entityType: "franchise_zone_fees", entityId: batchId ?? `recalc:${zoneSetCode}`, newValue: { reason: why, average: preview.average, counts: preview.counts, changed: preview.rows.filter((r) => r.changed).map((r) => ({ zoneId: r.zoneId, tier: r.newTier, feePaise: r.newFeePaise })) } }, tx);
    return preview;
  });
}

export async function discardBusinessBatch(batchId: string, actor: Actor): Promise<void> {
  requireAdmin(actor, "discard an import");
  await db.update(franchiseZoneBusiness).set({ status: "DISCARDED" }).where(and(eq(franchiseZoneBusiness.batchId, batchId), eq(franchiseZoneBusiness.status, "DRAFT")));
}

/** The fee version in force for a zone (new bookings and renewals). */
export async function currentFee(zoneId: string, client: DbClient = db): Promise<FranchiseZoneFeeVersion | null> {
  const [f] = await client.select().from(franchiseZoneFeeVersions).where(and(eq(franchiseZoneFeeVersions.zoneId, zoneId), isNull(franchiseZoneFeeVersions.supersededAt)));
  return f ?? null;
}

/** The fee version a renewal reminder compares with: the one in force when the franchise was bought / last renewed. */
export async function feeVersionById(id: string | null, client: DbClient = db): Promise<FranchiseZoneFeeVersion | null> {
  if (!id) return null;
  const [f] = await client.select().from(franchiseZoneFeeVersions).where(eq(franchiseZoneFeeVersions.id, id));
  return f ?? null;
}

/* ================================================================ status (§5.6) */

export interface StatusChangeInput {
  status: ZoneStatus;
  reason: string;
  reservedForDealerId?: string | null;
  reservedUntil?: Date | null;
  /** A future IST moment: the change is scheduled and applied by the job then. */
  scheduledFor?: Date | null;
}

/**
 * Admin changes the status of one zone or many (§5.6): a reason always; Reserved needs a dealer and an expiry; Sold
 * Out is the system's only. A future `scheduledFor` stores the change for the job. Every change is logged and the
 * zone's franchise owners and the CEO copy list are told.
 */
export async function changeZoneStatus(zoneIds: string[], input: StatusChangeInput, actor: Actor): Promise<{ applied: string[]; scheduled: string[] }> {
  requireAdmin(actor, "change a zone's status");
  const reason = requireReason(input.reason);
  if (!zoneIds.length) throw validationFailed("Choose at least one zone.");
  if (input.status === "SOLD_OUT") throw validationFailed("Sold Out is set by the system when every slot is taken.");
  if (input.status === "RESERVED") {
    if (!input.reservedForDealerId || !input.reservedUntil) throw validationFailed("A reservation needs the dealer and an expiry date.");
    if (input.reservedUntil.getTime() <= Date.now()) throw validationFailed("The reservation expiry must be in the future.");
    const [d] = await db.select({ id: dealers.id }).from(dealers).where(eq(dealers.id, input.reservedForDealerId));
    if (!d) throw validationFailed("Unknown dealer.");
  }
  const scheduled = input.scheduledFor && input.scheduledFor.getTime() > Date.now() ? input.scheduledFor : null;
  const applied: string[] = [];
  const queued: string[] = [];
  for (const zoneId of [...new Set(zoneIds)]) {
    if (scheduled) {
      await db.transaction(async (tx) => {
        const [z] = await tx.select().from(franchiseZones).where(eq(franchiseZones.zoneId, zoneId));
        if (!z) throw notFound(`Zone ${zoneId}`);
        await tx.insert(franchiseZoneStatusHistory).values({ zoneId, oldStatus: null, newStatus: input.status, reason, reservedForDealerId: input.reservedForDealerId ?? null, reservedUntil: input.reservedUntil ?? null, changedBy: actor.id, scheduledFor: scheduled });
        await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_ZONE_CHANGED, entityType: "franchise_zone", entityId: zoneId, newValue: { scheduled: input.status, at: scheduled.toISOString(), reason } }, tx);
      });
      queued.push(zoneId);
    } else {
      await applyStatus(zoneId, { ...input, reason }, actor);
      applied.push(zoneId);
    }
  }
  return { applied, scheduled: queued };
}

/** Cancels a scheduled change that has not been applied yet. */
export async function cancelScheduledStatus(historyId: string, actor: Actor): Promise<void> {
  requireAdmin(actor, "cancel a scheduled change");
  const rows = await db.update(franchiseZoneStatusHistory).set({ cancelledAt: new Date() }).where(and(eq(franchiseZoneStatusHistory.id, historyId), isNull(franchiseZoneStatusHistory.appliedAt), isNull(franchiseZoneStatusHistory.cancelledAt))).returning();
  if (!rows.length) throw conflict("That change was already applied or cancelled.");
}

async function applyStatus(zoneId: string, input: StatusChangeInput & { historyId?: string }, actor: Actor | null): Promise<boolean> {
  const result = await db.transaction(async (tx) => {
    const [z] = await tx.select().from(franchiseZones).where(eq(franchiseZones.zoneId, zoneId)).for("update");
    if (!z) throw notFound(`Zone ${zoneId}`);
    const now = new Date();
    let status = input.status;
    // Available with every slot taken by an active franchise is Sold Out (the system's status).
    if (status === "AVAILABLE" && (await activeCount(tx, zoneId)) >= z.maxOwners) status = "SOLD_OUT";
    const same = z.status === status && (status !== "RESERVED" || (z.reservedForDealerId === input.reservedForDealerId && z.reservedUntil?.getTime() === input.reservedUntil?.getTime()));
    if (input.historyId) await tx.update(franchiseZoneStatusHistory).set({ appliedAt: now, oldStatus: z.status }).where(eq(franchiseZoneStatusHistory.id, input.historyId));
    if (same) return null;
    await tx
      .update(franchiseZones)
      .set({ status, statusReason: input.reason, reservedForDealerId: status === "RESERVED" ? (input.reservedForDealerId ?? null) : null, reservedUntil: status === "RESERVED" ? (input.reservedUntil ?? null) : null, updatedAt: now })
      .where(eq(franchiseZones.zoneId, zoneId));
    if (!input.historyId) {
      await tx.insert(franchiseZoneStatusHistory).values({ zoneId, oldStatus: z.status, newStatus: status, reason: input.reason, reservedForDealerId: status === "RESERVED" ? (input.reservedForDealerId ?? null) : null, reservedUntil: status === "RESERVED" ? (input.reservedUntil ?? null) : null, changedBy: actor?.id ?? null, appliedAt: now });
    }
    await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.FRANCHISE_ZONE_CHANGED, entityType: "franchise_zone", entityId: zoneId, previousValue: { status: z.status }, newValue: { status, reason: input.reason, reservedForDealerId: input.reservedForDealerId ?? null, reservedUntil: input.reservedUntil?.toISOString() ?? null } }, tx);
    return { zone: z, from: z.status, to: status };
  });
  if (result) await tellZoneStatus(result.zone, result.from, result.to, input.reason).catch((e) => console.error("[franchise] zone status notice failed", zoneId, e));
  return !!result;
}

async function activeCount(client: DbClient, zoneId: string): Promise<number> {
  const [r] = await client.select({ n: sql<number>`count(*)::int` }).from(franchiseAllocations).where(and(eq(franchiseAllocations.zoneId, zoneId), inArray(franchiseAllocations.status, ["ACTIVE", "SUSPENDED"])));
  return Number(r?.n ?? 0);
}

/** §5.6: the zone's active franchise owners (in-app + e-mail) and the CEO copy list are told of every change. */
async function tellZoneStatus(zone: FranchiseZone, from: ZoneStatus, to: ZoneStatus, reason: string): Promise<void> {
  const { config } = await franchiseConfig();
  const owners = await db
    .select({ allocationId: franchiseAllocations.id, userId: dealers.userId, email: sql<string | null>`(select email from users u where u.id = ${dealers.userId})` })
    .from(franchiseAllocations)
    .innerJoin(dealers, eq(dealers.id, franchiseAllocations.ownerDealerId))
    .where(and(eq(franchiseAllocations.zoneId, zone.zoneId), inArray(franchiseAllocations.status, ["ACTIVE", "SUSPENDED"])));
  const when = formatIst(new Date());
  const message = `Zone ${zone.zoneId} (${zone.name}) is now ${ZONE_STATUS_LABELS[to]} (was ${ZONE_STATUS_LABELS[from]}) from ${when}. Reason: ${reason}. Your franchise term, fee and commission are not changed.`;
  const day = new Date().toISOString().slice(0, 10);
  for (const o of owners) {
    if (o.userId) await notify({ userId: o.userId, type: NOTIFICATION_TYPES.FRANCHISE_NOTICE, vars: { title: `Zone ${zone.zoneId}: ${ZONE_STATUS_LABELS[to]}`, message }, actionUrl: "/franchise/my", channels: ["IN_APP", "PUSH"], dedupeKey: `zone-status:${zone.zoneId}:${to}:${Date.now()}` }).catch(() => {});
  }
  const to_ = [...new Set([...owners.map((o) => o.email).filter((e): e is string => !!e), ...config.expiryCc])];
  for (const recipient of to_) {
    const [claimed] = await db.insert(franchiseNotificationLog).values({ allocationId: null, kind: `ZONE_STATUS:${zone.zoneId}:${to}:${Date.now()}`, dueOn: day, channel: "EMAIL", recipient, status: "QUEUED" }).onConflictDoNothing().returning({ id: franchiseNotificationLog.id });
    if (!claimed) continue;
    try {
      await sendEmail({ to: recipient, subject: `GoKesari franchise zone ${zone.zoneId} is now ${ZONE_STATUS_LABELS[to]}`, text: `${message}\n\nAll times IST.` });
      await db.update(franchiseNotificationLog).set({ status: "SENT" }).where(eq(franchiseNotificationLog.id, claimed.id));
    } catch (e) {
      await db.update(franchiseNotificationLog).set({ status: "FAILED", detail: e instanceof Error ? e.message.slice(0, 300) : String(e) }).where(eq(franchiseNotificationLog.id, claimed.id));
    }
  }
}

/** The job (every few minutes): due scheduled changes, expired reservations → Available. */
export async function runZoneStatusJobs(now: Date = new Date()): Promise<{ applied: number; reservationsExpired: number }> {
  const due = await db
    .select()
    .from(franchiseZoneStatusHistory)
    .where(and(isNull(franchiseZoneStatusHistory.appliedAt), isNull(franchiseZoneStatusHistory.cancelledAt), lte(franchiseZoneStatusHistory.scheduledFor, now)))
    .orderBy(asc(franchiseZoneStatusHistory.scheduledFor));
  let applied = 0;
  for (const h of due) {
    if (h.newStatus === "RESERVED" && h.reservedUntil && h.reservedUntil.getTime() <= now.getTime()) {
      await db.update(franchiseZoneStatusHistory).set({ cancelledAt: now }).where(eq(franchiseZoneStatusHistory.id, h.id));
      continue;
    }
    if (await applyStatus(h.zoneId, { status: h.newStatus, reason: `${h.reason} (scheduled for ${formatIst(h.scheduledFor!)})`, reservedForDealerId: h.reservedForDealerId, reservedUntil: h.reservedUntil, historyId: h.id }, null)) applied++;
  }
  const expired = await db.select().from(franchiseZones).where(and(eq(franchiseZones.status, "RESERVED"), lte(franchiseZones.reservedUntil, now)));
  for (const z of expired) await applyStatus(z.zoneId, { status: "AVAILABLE", reason: `Reservation ended ${formatIst(z.reservedUntil!)}` }, null);
  return { applied, reservationsExpired: expired.length };
}

/**
 * Sold Out set and cleared by the system (§5.6): Available with every slot held by an active franchise → Sold Out;
 * Sold Out with a slot free again → Available. Called after a franchise starts or ends.
 */
export async function syncSoldOut(zoneId: string): Promise<void> {
  const [z] = await db.select().from(franchiseZones).where(eq(franchiseZones.zoneId, zoneId));
  if (!z) return;
  const n = await activeCount(db, zoneId);
  if (z.status === "AVAILABLE" && n >= z.maxOwners) await applyStatus(zoneId, { status: "SOLD_OUT", reason: `All ${z.maxOwners} franchise slot(s) taken` }, null);
  else if (z.status === "SOLD_OUT" && n < z.maxOwners) await applyStatus(zoneId, { status: "AVAILABLE", reason: "A franchise slot is free again" }, null);
}

/** Max franchises in one zone: 1 or 2, never below its active franchises (§5.6). */
export async function setZoneMaxOwners(zoneId: string, maxOwners: number, reason: string, actor: Actor): Promise<void> {
  requireAdmin(actor, "change a zone");
  const why = requireReason(reason);
  if (![1, 2].includes(maxOwners)) throw validationFailed("A zone has 1 or 2 franchise slots.");
  await db.transaction(async (tx) => {
    const [z] = await tx.select().from(franchiseZones).where(eq(franchiseZones.zoneId, zoneId)).for("update");
    if (!z) throw notFound("Zone");
    const [held] = await tx.select({ n: sql<number>`count(*)::int` }).from(franchiseAllocations).where(and(eq(franchiseAllocations.zoneId, zoneId), inArray(franchiseAllocations.status, [...OCCUPYING_STATUSES])));
    if (maxOwners < Number(held?.n ?? 0)) throw conflict(`Zone ${zoneId} has ${held?.n} active or reserved franchise(s): the maximum cannot go below that.`);
    await tx.update(franchiseZones).set({ maxOwners, updatedAt: new Date() }).where(eq(franchiseZones.zoneId, zoneId));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_ZONE_CHANGED, entityType: "franchise_zone", entityId: zoneId, previousValue: { maxOwners: z.maxOwners }, newValue: { maxOwners, reason: why } }, tx);
  });
  await syncSoldOut(zoneId);
}

export async function zoneStatusHistory(zoneId?: string, limit = 200) {
  return db
    .select()
    .from(franchiseZoneStatusHistory)
    .where(zoneId ? eq(franchiseZoneStatusHistory.zoneId, zoneId) : undefined)
    .orderBy(desc(franchiseZoneStatusHistory.createdAt))
    .limit(limit);
}

/* ================================================================ map shapes (optional polygons) */

export interface BoundaryInput {
  ref: { lat: number; lng: number; label?: string | null } | null;
  shape: "POLYGON" | "CIRCLE" | "NONE";
  polygon?: LatLng[] | null;
  radiusM?: number | null;
  note?: string | null;
  source?: "ADMIN" | "GEOJSON" | "AUTO_GEOCODE";
}

const MAX_SHAPE_KM = 50;

function shapeOf(b: FranchiseZoneBoundary): { shape: "POLYGON"; polygon: LatLng[] } | { shape: "CIRCLE"; center: LatLng; radiusM: number } | null {
  if (b.shape === "POLYGON" && b.polygon?.length) return { shape: "POLYGON", polygon: b.polygon };
  if (b.shape === "CIRCLE" && b.refLat != null && b.refLng != null && b.radiusM) return { shape: "CIRCLE", center: [Number(b.refLat), Number(b.refLng)], radiusM: b.radiusM };
  return null;
}

/** Saves a DRAFT map shape for a zone (a new version); errors are returned so the editor can show them. */
export async function saveBoundaryDraft(zoneId: string, input: BoundaryInput, actor: Actor): Promise<{ boundary: FranchiseZoneBoundary; errors: string[] }> {
  requireAdmin(actor, "edit zone shapes");
  const ref: LatLng | null = input.ref ? [Number(input.ref.lat), Number(input.ref.lng)] : null;
  const check = input.shape === "NONE" ? { errors: [] as string[], maxDistanceM: 0 } : validateBoundary({ shape: input.shape, polygon: input.polygon ?? null, center: ref, radiusM: input.radiusM ?? null, ref }, MAX_SHAPE_KM);
  const boundary = await db.transaction(async (tx) => {
    const [z] = await tx.select().from(franchiseZones).where(eq(franchiseZones.zoneId, zoneId)).for("update");
    if (!z) throw notFound("Zone");
    const [v] = await tx.select({ v: sql<number>`coalesce(max(${franchiseZoneBoundaries.version}), 0)::int` }).from(franchiseZoneBoundaries).where(eq(franchiseZoneBoundaries.zoneId, zoneId));
    const [row] = await tx
      .insert(franchiseZoneBoundaries)
      .values({
        zoneId,
        version: Number(v?.v ?? 0) + 1,
        refLat: ref ? ref[0] : null,
        refLng: ref ? ref[1] : null,
        refLabel: input.ref?.label?.slice(0, 200) ?? null,
        refSource: input.source ?? "ADMIN",
        shape: input.shape,
        polygon: input.shape === "POLYGON" ? (input.polygon ?? []).map(([a, b]) => [Number(a), Number(b)] as LatLng) : null,
        radiusM: input.shape === "CIRCLE" ? Math.round(Number(input.radiusM)) : null,
        maxDistanceM: check.maxDistanceM,
        status: "DRAFT",
        note: input.note?.slice(0, 500) ?? null,
        createdBy: actor.id,
      })
      .returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_BOUNDARY_CHANGED, entityType: "franchise_zone", entityId: zoneId, newValue: { drafted: row.version, shape: input.shape, errors: check.errors } }, tx);
    return row;
  });
  return { boundary, errors: check.errors };
}

/** Approves the latest draft shape (map display only; a shop's zone comes from its area, never from the shape). */
export async function approveBoundary(zoneId: string, actor: Actor): Promise<{ approved: boolean; errors: string[] }> {
  requireAdmin(actor, "approve zone shapes");
  return db.transaction(async (tx) => {
    const [draft] = await tx.select().from(franchiseZoneBoundaries).where(and(eq(franchiseZoneBoundaries.zoneId, zoneId), eq(franchiseZoneBoundaries.status, "DRAFT"))).orderBy(desc(franchiseZoneBoundaries.version)).limit(1);
    if (!draft) throw conflict("Save a shape draft first.");
    if (!shapeOf(draft)) return { approved: false, errors: ["The draft has no polygon or circle."] };
    const now = new Date();
    await tx.update(franchiseZoneBoundaries).set({ status: "SUPERSEDED" }).where(and(eq(franchiseZoneBoundaries.zoneId, zoneId), eq(franchiseZoneBoundaries.status, "APPROVED")));
    await tx.update(franchiseZoneBoundaries).set({ status: "APPROVED", approvedBy: actor.id, approvedAt: now, refNeedsReview: false }).where(eq(franchiseZoneBoundaries.id, draft.id));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_BOUNDARY_CHANGED, entityType: "franchise_zone", entityId: zoneId, newValue: { approved: draft.version } }, tx);
    return { approved: true, errors: [] };
  });
}

/** Bulk GeoJSON import: one DRAFT shape per feature with a zone_id property. */
export async function importBoundariesGeoJson(geojson: unknown, actor: Actor): Promise<{ drafted: string[]; unknown: string[]; invalid: { zoneId: string; errors: string[] }[] }> {
  const items = polygonsFromGeoJson(geojson);
  if (!items.length) throw validationFailed("No polygons with a zone_id were found in the GeoJSON.");
  const known = new Set((await db.select({ id: franchiseZones.zoneId }).from(franchiseZones)).map((r) => r.id));
  const drafted: string[] = [];
  const unknownIds: string[] = [];
  const invalid: { zoneId: string; errors: string[] }[] = [];
  for (const item of items) {
    if (!known.has(item.zoneId)) {
      unknownIds.push(item.zoneId);
      continue;
    }
    const n = item.polygon.length;
    const ref = n ? { lat: item.polygon.reduce((s, p) => s + p[0], 0) / n, lng: item.polygon.reduce((s, p) => s + p[1], 0) / n, label: "Polygon centre (import)" } : null;
    const { errors } = await saveBoundaryDraft(item.zoneId, { ref, shape: "POLYGON", polygon: item.polygon, source: "GEOJSON", note: "GeoJSON import" }, actor);
    drafted.push(item.zoneId);
    if (errors.length) invalid.push({ zoneId: item.zoneId, errors });
  }
  return { drafted, unknown: unknownIds, invalid };
}

/**
 * The booking map (§5.5): each zone as a feature coloured by tier — its approved polygon when an admin has drawn
 * one, otherwise a point at the centre of its areas. Properties carry the badge, slots, tier and fee.
 */
export async function zonesGeoJson(options: { includeTest?: boolean; zoneIds?: string[] } = {}): Promise<unknown> {
  const zones = await zoneViews({ includeTest: options.includeTest, zoneIds: options.zoneIds });
  const shapes = await db.select().from(franchiseZoneBoundaries).where(eq(franchiseZoneBoundaries.status, "APPROVED"));
  const features: unknown[] = [];
  for (const z of zones) {
    const props = { zone_id: z.zoneId, name: z.name, region: z.region, tier: z.tier, tierName: z.tierName, colour: z.tierColour, badge: z.badge, status: z.status, slotsFree: z.slotsFree, feePaise: z.feePaise, provisional: z.provisional };
    const b = shapes.find((s) => s.zoneId === z.zoneId);
    const s = b ? shapeOf(b) : null;
    const ring = s ? boundaryRing(s) : [];
    if (ring.length >= 3) features.push({ type: "Feature", id: z.zoneId, properties: props, geometry: { type: "Polygon", coordinates: [[...ring, ring[0]].map(([lat, lng]) => [lng, lat])] } });
    else if (z.centre) features.push({ type: "Feature", id: z.zoneId, properties: props, geometry: { type: "Point", coordinates: [z.centre[1], z.centre[0]] } });
  }
  return { type: "FeatureCollection", features };
}

/* ================================================================ test zone (production end-to-end check) */

/** An admin-only hidden test zone with one test area, for the production end-to-end booking. */
export async function ensureTestZone(actor: Actor): Promise<string> {
  requireAdmin(actor, "do this");
  const zoneId = "T-QA1";
  const { config } = await franchiseConfig();
  await db.transaction(async (tx) => {
    const set = config.zoneSetsEnabled[0] ?? "PUN";
    await tx.insert(franchiseZones).values({ zoneId, zoneSetCode: set, clusterNo: 999, name: "QA test zone (hidden, admin only)", region: "Test", reason: "Test zone", status: "AVAILABLE", isTest: true, statusReason: "Test zone" }).onConflictDoNothing();
    await tx.insert(franchiseAreas).values({ zoneSetCode: set, areaNo: 9999, name: "QA test area (sea)", region: "Test", zoneId, lat: 18.9, lng: 72.6, isTest: true }).onConflictDoNothing();
    const [fee] = await tx.select({ id: franchiseZoneFeeVersions.id }).from(franchiseZoneFeeVersions).where(eq(franchiseZoneFeeVersions.zoneId, zoneId));
    if (!fee) await tx.insert(franchiseZoneFeeVersions).values({ zoneId, tier: "STANDARD", value: 100, average: 100, diffBp: 0, feePaise: config.standardFeePaise, reason: "Test zone", provisional: false, createdBy: actor.id });
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_ZONE_CHANGED, entityType: "franchise_zone", entityId: zoneId, newValue: { testZone: true } }, tx);
  });
  return zoneId;
}

/** Area-to-zone mapping summary for the Admin area master. */
export async function areaSummary(zoneSetCode: string): Promise<{ total: number; zoned: number; unzoned: string[] }> {
  const areas = await listAreas({ zoneSetCode });
  return { total: areas.length, zoned: areas.filter((a) => a.zoneId).length, unzoned: areas.filter((a) => !a.zoneId).map((a) => a.name) };
}

/**
 * §5.1 at registration: the area the user confirmed (`areaId`), or — when none was sent (older app, API) — the best
 * suggestion from the shop's PIN code and location. Never blocks a registration: a failure is logged.
 */
export async function assignAreaAtRegistration(shopId: string, input: { areaId?: string | null; latitude?: number | string | null; longitude?: number | string | null; pincode?: string | null }, actor: Actor | null): Promise<string | null> {
  try {
    let areaId = input.areaId ?? null;
    if (!areaId) {
      const lat = input.latitude == null || input.latitude === "" ? null : Number(input.latitude);
      const lng = input.longitude == null || input.longitude === "" ? null : Number(input.longitude);
      const [best] = await suggestAreas({ lat, lng, pincode: input.pincode ?? null, limit: 1 });
      areaId = best?.id ?? null;
    }
    if (!areaId) return null;
    return await db.transaction((tx) => setShopArea(tx, shopId, areaId!, { source: "REGISTRATION", actor, reason: input.areaId ? "chosen at registration" : "suggested from PIN code / location" }));
  } catch (e) {
    console.error("[franchise] could not record the shop's area", shopId, e instanceof Error ? e.message : e);
    return null;
  }
}
