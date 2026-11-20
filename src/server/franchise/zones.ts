/**
 * Pune PMR zones (brief §4–§6): the 91-zone master, availability (two slots a zone), the cluster summary,
 * boundaries (reference point + polygon or circle, ≤ 5 km, no overlap), splitting large zones, GeoJSON
 * import and placing a point in exactly one zone. Owners live on franchise_allocations, never on the zone.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import {
  OCCUPYING_STATUSES,
  boundaryContains,
  boundaryRing,
  compareZoneIds,
  polygonsFromGeoJson,
  ringsOverlap,
  validateBoundary,
  zoneBadge,
  zoneEstimate,
  zoneSortKey,
  type LatLng,
  type ZoneBadge,
  type ZoneStatus,
} from "@/lib/franchise";
import { getEnv, isGeocodingConfigured } from "@/lib/env";
import { db, type DbClient } from "@/server/db";
import {
  franchiseAllocations,
  franchiseClusters,
  franchiseZoneBoundaries,
  franchiseZoneEstimates,
  franchiseZonePins,
  franchiseZones,
  mapsApiCallLog,
  type FranchiseZoneBoundary,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { franchiseConfig, franchiseNow } from "./config";

export interface Actor {
  id: string;
  role: UserRole;
}

export interface ZoneView {
  zoneId: string;
  clusterCode: string;
  clusterName: string;
  name: string;
  pinCodes: string[];
  commercialProfile: string;
  origin: "ORIGINAL" | "SPLIT" | "SUB_ZONE" | "TEST";
  splitFromZone: string | null;
  parentZoneId: string | null;
  status: ZoneStatus;
  statusReason: string | null;
  isTest: boolean;
  maxOwners: number;
  occupied: number;
  slotsFree: number;
  badge: ZoneBadge;
  bookable: boolean;
  estShops: number;
  gmvPerShopLakh: number;
  monthlyCrHundredths: number;
  annualCrHundredths: number;
  estimateAsOf: string | null;
  hasApprovedBoundary: boolean;
  reference: { lat: number; lng: number; label: string | null; needsReview: boolean } | null;
}

/** Occupied slots of every zone, an expired hold counting as free (brief §4.4: "treated as free at read time"). */
async function occupancy(client: DbClient, now: Date): Promise<Map<string, number>> {
  const rows = await client
    .select({ zoneId: franchiseAllocations.zoneId, n: sql<number>`count(*)::int` })
    .from(franchiseAllocations)
    .where(
      sql`${franchiseAllocations.status} in ('PAYMENT_PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED') or (${franchiseAllocations.status} = 'RESERVED' and ${franchiseAllocations.holdExpiresAt} > ${now.toISOString()}::timestamptz)`,
    )
    .groupBy(franchiseAllocations.zoneId);
  return new Map(rows.map((r) => [r.zoneId, Number(r.n)]));
}

/** Every zone of the enabled regions with its estimate and availability. Test zones only for admins. */
export async function zoneViews(options: { includeTest?: boolean; zoneIds?: string[]; client?: DbClient } = {}): Promise<ZoneView[]> {
  const client = options.client ?? db;
  const { config } = await franchiseConfig(client);
  const now = franchiseNow(config);
  const zones = await client
    .select({ z: franchiseZones, clusterName: franchiseClusters.name })
    .from(franchiseZones)
    .innerJoin(franchiseClusters, eq(franchiseClusters.code, franchiseZones.clusterCode))
    .where(and(inArray(franchiseZones.regionCode, config.regionsEnabled), options.zoneIds?.length ? inArray(franchiseZones.zoneId, options.zoneIds) : undefined));
  const ids = zones.map((r) => r.z.zoneId);
  if (!ids.length) return [];
  const [pins, estimates, boundaries, occ] = await Promise.all([
    client.select().from(franchiseZonePins).where(inArray(franchiseZonePins.zoneId, ids)),
    client.select().from(franchiseZoneEstimates).where(and(inArray(franchiseZoneEstimates.zoneId, ids), eq(franchiseZoneEstimates.isCurrent, true))),
    client.select().from(franchiseZoneBoundaries).where(inArray(franchiseZoneBoundaries.zoneId, ids)).orderBy(desc(franchiseZoneBoundaries.version)),
    occupancy(client, now),
  ]);
  const pinMap = new Map<string, string[]>();
  for (const p of pins) pinMap.set(p.zoneId, [...(pinMap.get(p.zoneId) ?? []), p.pincode].sort());
  const estMap = new Map(estimates.map((e) => [e.zoneId, e]));
  const approved = new Map<string, FranchiseZoneBoundary>();
  const latest = new Map<string, FranchiseZoneBoundary>();
  for (const b of boundaries) {
    if (!latest.has(b.zoneId)) latest.set(b.zoneId, b);
    if (b.status === "APPROVED") approved.set(b.zoneId, b);
  }
  const views = zones
    .filter((r) => options.includeTest || !r.z.isTest)
    .map(({ z, clusterName }): ZoneView => {
      const est = estMap.get(z.zoneId);
      const e = zoneEstimate({ estShopCount: est?.estShopCount ?? 0, gmvPerShopLakh: est?.gmvPerShopLakh ?? 0 });
      const maxOwners = Math.min(z.maxOwners, config.maxOwnersPerZone);
      const occupied = occ.get(z.zoneId) ?? 0;
      const hasApproved = approved.has(z.zoneId);
      const status: ZoneStatus = z.status === "BOOKABLE" && !hasApproved ? "BOUNDARY_PENDING" : z.status;
      const ref = approved.get(z.zoneId) ?? latest.get(z.zoneId);
      return {
        zoneId: z.zoneId,
        clusterCode: z.clusterCode,
        clusterName,
        name: z.name,
        pinCodes: pinMap.get(z.zoneId) ?? [],
        commercialProfile: z.commercialProfile,
        origin: z.origin,
        splitFromZone: z.splitFromZone,
        parentZoneId: z.parentZoneId,
        status,
        statusReason: z.statusReason,
        isTest: z.isTest,
        maxOwners,
        occupied,
        slotsFree: Math.max(0, maxOwners - occupied),
        badge: zoneBadge(status, maxOwners, occupied),
        bookable: status === "BOOKABLE" && occupied < maxOwners,
        estShops: e.shops,
        gmvPerShopLakh: e.gmvPerShopLakh,
        monthlyCrHundredths: e.monthlyCrHundredths,
        annualCrHundredths: e.annualCrHundredths,
        estimateAsOf: est?.asOf ?? null,
        hasApprovedBoundary: hasApproved,
        reference: ref?.refLat != null && ref.refLng != null ? { lat: Number(ref.refLat), lng: Number(ref.refLng), label: ref.refLabel, needsReview: ref.refNeedsReview } : null,
      };
    })
    .filter((v) => v.status !== "RETIRED" || options.includeTest);
  return views.sort((a, b) => compareZoneIds(a.zoneId, b.zoneId));
}

export interface ZoneFilter {
  q?: string;
  cluster?: string;
  availability?: "2" | "1" | "0";
  minAnnualCr?: number;
  maxAnnualCr?: number;
  profile?: string;
  origin?: "ORIGINAL" | "SPLIT";
  sort?: "annual" | "shops" | "zone";
}

/** Search, filter and sort (brief §4.2): annual business high → low by default. */
export function filterZones(zones: ZoneView[], f: ZoneFilter): ZoneView[] {
  const q = (f.q ?? "").trim().toLowerCase();
  const out = zones.filter((z) => {
    if (f.cluster && f.cluster !== "ALL" && z.clusterCode !== f.cluster) return false;
    if (f.availability === "2" && !(z.status === "BOOKABLE" && z.slotsFree >= 2)) return false;
    if (f.availability === "1" && !(z.status === "BOOKABLE" && z.slotsFree === 1)) return false;
    if (f.availability === "0" && !(z.status === "BOOKABLE" && z.slotsFree === 0)) return false;
    if (f.minAnnualCr != null && z.annualCrHundredths < f.minAnnualCr * 100) return false;
    if (f.maxAnnualCr != null && z.annualCrHundredths > f.maxAnnualCr * 100) return false;
    if (f.profile && !z.commercialProfile.toLowerCase().includes(f.profile.toLowerCase())) return false;
    if (f.origin === "ORIGINAL" && z.origin !== "ORIGINAL") return false;
    if (f.origin === "SPLIT" && z.origin === "ORIGINAL") return false;
    if (q) {
      const hay = `${z.zoneId} ${z.name} ${z.pinCodes.join(" ")} ${z.commercialProfile} ${z.clusterName}`.toLowerCase();
      if (!hay.includes(q) && z.zoneId.toLowerCase() !== q) return false;
    }
    return true;
  });
  const sort = f.sort ?? "annual";
  return out.sort((a, b) =>
    sort === "zone" ? zoneSortKey(a.zoneId) - zoneSortKey(b.zoneId) : sort === "shops" ? b.estShops - a.estShops || compareZoneIds(a.zoneId, b.zoneId) : b.annualCrHundredths - a.annualCrHundredths || compareZoneIds(a.zoneId, b.zoneId),
  );
}

export interface ClusterSummary {
  code: string;
  name: string;
  zones: number;
  estShops: number;
  avgShopsPerZone: number;
  monthlyCrHundredths: number;
  annualCrHundredths: number;
  largestZoneCrHundredths: number;
  largestZoneId: string | null;
  bookable: number;
  slotsFree: number;
}

/** The cluster summary generated in the app (brief §5: the workbook's own summary is broken). */
export function clusterSummary(zones: ZoneView[], clusters: { code: string; name: string }[]): { clusters: ClusterSummary[]; total: ClusterSummary } {
  const rows = clusters.map((c): ClusterSummary => {
    const zs = zones.filter((z) => z.clusterCode === c.code && !z.isTest && z.status !== "RETIRED");
    const largest = zs.reduce<ZoneView | null>((m, z) => (!m || z.annualCrHundredths > m.annualCrHundredths ? z : m), null);
    const estShops = zs.reduce((s, z) => s + z.estShops, 0);
    return {
      code: c.code,
      name: c.name,
      zones: zs.length,
      estShops,
      avgShopsPerZone: zs.length ? Math.round(estShops / zs.length) : 0,
      monthlyCrHundredths: zs.reduce((s, z) => s + z.monthlyCrHundredths, 0),
      annualCrHundredths: zs.reduce((s, z) => s + z.annualCrHundredths, 0),
      largestZoneCrHundredths: largest?.annualCrHundredths ?? 0,
      largestZoneId: largest?.zoneId ?? null,
      bookable: zs.filter((z) => z.bookable).length,
      slotsFree: zs.reduce((s, z) => s + (z.status === "BOOKABLE" ? z.slotsFree : 0), 0),
    };
  });
  const total: ClusterSummary = {
    code: "PMR",
    name: "Total PMR",
    zones: rows.reduce((s, r) => s + r.zones, 0),
    estShops: rows.reduce((s, r) => s + r.estShops, 0),
    avgShopsPerZone: 0,
    monthlyCrHundredths: rows.reduce((s, r) => s + r.monthlyCrHundredths, 0),
    annualCrHundredths: rows.reduce((s, r) => s + r.annualCrHundredths, 0),
    largestZoneCrHundredths: Math.max(0, ...rows.map((r) => r.largestZoneCrHundredths)),
    largestZoneId: rows.reduce<ClusterSummary | null>((m, r) => (!m || r.largestZoneCrHundredths > m.largestZoneCrHundredths ? r : m), null)?.largestZoneId ?? null,
    bookable: rows.reduce((s, r) => s + r.bookable, 0),
    slotsFree: rows.reduce((s, r) => s + r.slotsFree, 0),
  };
  total.avgShopsPerZone = total.zones ? Math.round(total.estShops / total.zones) : 0;
  return { clusters: rows, total };
}

export async function listClusters(client: DbClient = db): Promise<{ code: string; name: string }[]> {
  const { config } = await franchiseConfig(client);
  return client
    .select({ code: franchiseClusters.code, name: franchiseClusters.name })
    .from(franchiseClusters)
    .where(inArray(franchiseClusters.regionCode, config.regionsEnabled))
    .orderBy(franchiseClusters.sortOrder);
}

/* ============================================================= boundaries */

function shapeOf(b: FranchiseZoneBoundary): { shape: "POLYGON" | "CIRCLE"; polygon: LatLng[] | null; center: LatLng | null; radiusM: number | null } | null {
  if (b.shape === "NONE") return null;
  const center: LatLng | null = b.refLat != null && b.refLng != null ? [Number(b.refLat), Number(b.refLng)] : null;
  return { shape: b.shape, polygon: b.polygon ?? null, center, radiusM: b.radiusM };
}

/** Approved boundaries of zones that can take shops (BOOKABLE or PAUSED, not retired / test unless asked). */
export async function approvedBoundaries(client: DbClient = db, options: { includeTest?: boolean } = {}): Promise<{ zoneId: string; boundary: FranchiseZoneBoundary }[]> {
  const rows = await client
    .select({ b: franchiseZoneBoundaries, z: franchiseZones })
    .from(franchiseZoneBoundaries)
    .innerJoin(franchiseZones, eq(franchiseZones.zoneId, franchiseZoneBoundaries.zoneId))
    .where(eq(franchiseZoneBoundaries.status, "APPROVED"));
  return rows.filter((r) => r.z.status !== "RETIRED" && (options.includeTest || !r.z.isTest)).map((r) => ({ zoneId: r.z.zoneId, boundary: r.b }));
}

/** The zones whose approved boundary contains the point (brief §6: must be exactly one; overlap is refused at approval). */
export async function zonesContaining(lat: number, lng: number, client: DbClient = db, options: { includeTest?: boolean } = {}): Promise<string[]> {
  const p: LatLng = [lat, lng];
  const out: string[] = [];
  for (const { zoneId, boundary } of await approvedBoundaries(client, { includeTest: options.includeTest ?? true })) {
    const s = shapeOf(boundary);
    if (s && boundaryContains(s, p)) out.push(zoneId);
  }
  return out.sort(compareZoneIds);
}

export interface BoundaryInput {
  ref: { lat: number; lng: number; label?: string | null } | null;
  shape: "POLYGON" | "CIRCLE" | "NONE";
  polygon?: LatLng[] | null;
  radiusM?: number | null;
  note?: string | null;
  source?: "ADMIN" | "GEOJSON" | "AUTO_GEOCODE";
}

async function nextVersion(client: DbClient, zoneId: string): Promise<number> {
  const [r] = await client.select({ v: sql<number>`coalesce(max(${franchiseZoneBoundaries.version}), 0)::int` }).from(franchiseZoneBoundaries).where(eq(franchiseZoneBoundaries.zoneId, zoneId));
  return Number(r?.v ?? 0) + 1;
}

async function requireZone(client: DbClient, zoneId: string) {
  const [z] = await client.select().from(franchiseZones).where(eq(franchiseZones.zoneId, zoneId));
  if (!z) throw notFound("Zone");
  return z;
}

/** Saves a DRAFT boundary (a new version). Validation errors are returned, not thrown, so the editor can show them. */
export async function saveBoundaryDraft(zoneId: string, input: BoundaryInput, actor: Actor): Promise<{ boundary: FranchiseZoneBoundary; errors: string[] }> {
  if (actor.role !== "ADMIN") throw validationFailed("Only an admin can edit boundaries.");
  await requireZone(db, zoneId);
  const { config } = await franchiseConfig();
  const ref: LatLng | null = input.ref ? [Number(input.ref.lat), Number(input.ref.lng)] : null;
  const check =
    input.shape === "NONE"
      ? { ok: true, errors: [] as string[], maxDistanceM: 0 }
      : validateBoundary({ shape: input.shape, polygon: input.polygon ?? null, center: ref, radiusM: input.radiusM ?? null, ref }, config.maxAreaRadiusKm);
  const boundary = await db.transaction(async (tx) => {
    await tx.select().from(franchiseZones).where(eq(franchiseZones.zoneId, zoneId)).for("update");
    const version = await nextVersion(tx, zoneId);
    const [row] = await tx
      .insert(franchiseZoneBoundaries)
      .values({
        zoneId,
        version,
        refLat: ref ? ref[0] : null,
        refLng: ref ? ref[1] : null,
        refLabel: input.ref?.label?.slice(0, 200) ?? null,
        refSource: input.source ?? "ADMIN",
        refNeedsReview: input.source === "AUTO_GEOCODE",
        shape: input.shape,
        polygon: input.shape === "POLYGON" ? (input.polygon ?? []).map(([a, b]) => [Number(a), Number(b)] as LatLng) : null,
        radiusM: input.shape === "CIRCLE" ? Math.round(Number(input.radiusM)) : null,
        maxDistanceM: check.maxDistanceM,
        status: "DRAFT",
        note: input.note?.slice(0, 500) ?? null,
        createdBy: actor.id,
      })
      .returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_BOUNDARY_CHANGED, entityType: "franchise_zone", entityId: zoneId, newValue: { drafted: version, shape: input.shape, source: input.source ?? "ADMIN", errors: check.errors } }, tx);
    return row;
  });
  return { boundary, errors: check.errors };
}

/**
 * Approves the latest draft (brief §6): ≤ 5 km of the reference point, no overlap with another approved zone.
 * A zone that cannot fit becomes NEEDS_SPLIT; otherwise BOUNDARY_PENDING / NEEDS_SPLIT → BOOKABLE.
 */
export async function approveBoundary(zoneId: string, actor: Actor): Promise<{ approved: boolean; errors: string[] }> {
  if (actor.role !== "ADMIN") throw validationFailed("Only an admin can approve boundaries.");
  const { config } = await franchiseConfig();
  return db.transaction(async (tx) => {
    // One approval at a time across zones (the overlap check reads the others).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('franchise-boundaries'))`);
    const zone = await requireZone(tx, zoneId);
    const [draft] = await tx.select().from(franchiseZoneBoundaries).where(and(eq(franchiseZoneBoundaries.zoneId, zoneId), eq(franchiseZoneBoundaries.status, "DRAFT"))).orderBy(desc(franchiseZoneBoundaries.version)).limit(1);
    if (!draft) throw conflict("Save a boundary draft first.");
    const shape = shapeOf(draft);
    if (!shape) throw conflict("The draft has no polygon or circle.");
    const ref: LatLng | null = draft.refLat != null && draft.refLng != null ? [Number(draft.refLat), Number(draft.refLng)] : null;
    const errors = [...validateBoundary({ ...shape, ref }, config.maxAreaRadiusKm).errors];
    const ring = boundaryRing(shape);
    // Brief 21-Nov §1.1: an area is everything within 5 km of its centre, so neighbouring areas may overlap
    // (the dealer code decides which area a shop is in). allowOverlappingAreas false: the 20-Nov no-overlap rule.
    for (const other of config.allowOverlappingAreas ? [] : await approvedBoundaries(tx, { includeTest: true })) {
      if (other.zoneId === zoneId) continue;
      const os = shapeOf(other.boundary);
      if (os && ringsOverlap(ring, boundaryRing(os))) errors.push(`It overlaps zone ${other.zoneId}.`);
    }
    if (errors.length) {
      const tooBig = errors.some((e) => /limit is/.test(e));
      if (tooBig && zone.status === "BOUNDARY_PENDING") {
        await tx.update(franchiseZones).set({ status: "NEEDS_SPLIT", statusReason: "Does not fit within the 5 km limit", updatedAt: new Date() }).where(eq(franchiseZones.zoneId, zoneId));
      }
      await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_BOUNDARY_CHANGED, entityType: "franchise_zone", entityId: zoneId, newValue: { approveRefused: draft.version, errors } }, tx);
      return { approved: false, errors };
    }
    const now = new Date();
    await tx.update(franchiseZoneBoundaries).set({ status: "SUPERSEDED" }).where(and(eq(franchiseZoneBoundaries.zoneId, zoneId), eq(franchiseZoneBoundaries.status, "APPROVED")));
    await tx.update(franchiseZoneBoundaries).set({ status: "APPROVED", approvedBy: actor.id, approvedAt: now, refNeedsReview: false }).where(eq(franchiseZoneBoundaries.id, draft.id));
    if (zone.status === "BOUNDARY_PENDING" || zone.status === "NEEDS_SPLIT") {
      await tx.update(franchiseZones).set({ status: "BOOKABLE", statusReason: null, updatedAt: now }).where(eq(franchiseZones.zoneId, zoneId));
    }
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_BOUNDARY_CHANGED, entityType: "franchise_zone", entityId: zoneId, previousValue: { status: zone.status }, newValue: { approved: draft.version, status: "BOOKABLE", maxDistanceM: draft.maxDistanceM } }, tx);
    return { approved: true, errors: [] };
  });
}

/** Bulk import (brief §6): one DRAFT per feature, keeping the zone's reference point (or the polygon's centre). */
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
    const [latest] = await db.select().from(franchiseZoneBoundaries).where(eq(franchiseZoneBoundaries.zoneId, item.zoneId)).orderBy(desc(franchiseZoneBoundaries.version)).limit(1);
    const centre = item.polygon.length ? ([item.polygon.reduce((s, p) => s + p[0], 0) / item.polygon.length, item.polygon.reduce((s, p) => s + p[1], 0) / item.polygon.length] as LatLng) : null;
    const ref = latest?.refLat != null && latest.refLng != null ? { lat: Number(latest.refLat), lng: Number(latest.refLng), label: latest.refLabel } : centre ? { lat: centre[0], lng: centre[1], label: "Polygon centre (import)" } : null;
    const { errors } = await saveBoundaryDraft(item.zoneId, { ref, shape: "POLYGON", polygon: item.polygon, source: "GEOJSON", note: "GeoJSON import" }, actor);
    drafted.push(item.zoneId);
    if (errors.length) invalid.push({ zoneId: item.zoneId, errors });
  }
  return { drafted, unknown: unknownIds, invalid };
}

/** Zone status by an admin: pause / resume, retire, mark NEEDS_SPLIT (audited). */
export async function setZoneStatus(zoneId: string, status: ZoneStatus, reason: string, actor: Actor): Promise<void> {
  if (actor.role !== "ADMIN") throw validationFailed("Only an admin can change a zone.");
  if (reason.trim().length < 5) throw validationFailed("Give a reason of at least 5 characters.");
  await db.transaction(async (tx) => {
    const zone = await requireZone(tx, zoneId);
    if (status === "BOOKABLE") {
      const [ok] = await tx.select({ id: franchiseZoneBoundaries.id }).from(franchiseZoneBoundaries).where(and(eq(franchiseZoneBoundaries.zoneId, zoneId), eq(franchiseZoneBoundaries.status, "APPROVED")));
      if (!ok) throw conflict("Approve a boundary first: a zone without an approved boundary is not bookable.");
    }
    await tx.update(franchiseZones).set({ status, statusReason: reason.trim().slice(0, 300), updatedAt: new Date() }).where(eq(franchiseZones.zoneId, zoneId));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_ZONE_CHANGED, entityType: "franchise_zone", entityId: zoneId, previousValue: { status: zone.status }, newValue: { status, reason } }, tx);
  });
}

/** Max owners of one zone: 1 or 2 (the database refuses more). Raising back to 2 needs a super-admin. */
export async function setZoneMaxOwners(zoneId: string, maxOwners: number, reason: string, actor: Actor & { superAdmin?: boolean }): Promise<void> {
  if (actor.role !== "ADMIN") throw validationFailed("Only an admin can change a zone.");
  if (![1, 2].includes(maxOwners)) throw validationFailed("An area has 1 or 2 owner slots.");
  await db.transaction(async (tx) => {
    const zone = await requireZone(tx, zoneId);
    if (maxOwners > zone.maxOwners && !actor.superAdmin) throw validationFailed("Only a super-admin can raise the number of owners of an area.");
    await tx.update(franchiseZones).set({ maxOwners, updatedAt: new Date() }).where(eq(franchiseZones.zoneId, zoneId));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_ZONE_CHANGED, entityType: "franchise_zone", entityId: zoneId, previousValue: { maxOwners: zone.maxOwners }, newValue: { maxOwners, reason } }, tx);
  });
}

/**
 * Splits a zone too large for 5 km (brief §6) into sub-zones 66-1, 66-2 …: the parent's GMV per shop is kept,
 * the shop count divided as entered (must add up to the parent's). The parent is RETIRED; nothing is booked
 * on it while it is split. Every split is audited.
 */
export async function splitZone(zoneId: string, parts: { name: string; shops: number }[], reason: string, actor: Actor): Promise<string[]> {
  if (actor.role !== "ADMIN") throw validationFailed("Only an admin can split a zone.");
  if (parts.length < 2 || parts.length > 9) throw validationFailed("Split into 2 to 9 sub-zones.");
  if (reason.trim().length < 5) throw validationFailed("Give a reason of at least 5 characters.");
  return db.transaction(async (tx) => {
    const [zone] = await tx.select().from(franchiseZones).where(eq(franchiseZones.zoneId, zoneId)).for("update");
    if (!zone) throw notFound("Zone");
    if (zone.parentZoneId) throw conflict("A sub-zone cannot be split again.");
    const [busy] = await tx.select({ id: franchiseAllocations.id }).from(franchiseAllocations).where(and(eq(franchiseAllocations.zoneId, zoneId), inArray(franchiseAllocations.status, [...OCCUPYING_STATUSES])));
    if (busy) throw conflict("This zone has owners or reservations; it cannot be split.");
    const [est] = await tx.select().from(franchiseZoneEstimates).where(and(eq(franchiseZoneEstimates.zoneId, zoneId), eq(franchiseZoneEstimates.isCurrent, true)));
    const total = parts.reduce((s, p) => s + Math.trunc(p.shops), 0);
    if (est && total !== est.estShopCount) throw validationFailed(`The sub-zones' shops must add up to ${est.estShopCount.toLocaleString("en-IN")} (now ${total.toLocaleString("en-IN")}).`);
    const pins = await tx.select().from(franchiseZonePins).where(eq(franchiseZonePins.zoneId, zoneId));
    const ids: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const id = `${zoneId}-${i + 1}`;
      ids.push(id);
      await tx.insert(franchiseZones).values({
        zoneId: id,
        regionCode: zone.regionCode,
        clusterCode: zone.clusterCode,
        name: parts[i].name.trim().slice(0, 200) || `${zone.name} (part ${i + 1})`,
        commercialProfile: zone.commercialProfile,
        origin: "SUB_ZONE",
        splitFromZone: zone.zoneId,
        parentZoneId: zone.zoneId,
        status: "BOUNDARY_PENDING",
        maxOwners: zone.maxOwners,
        sortKey: zoneSortKey(id),
      });
      if (pins.length) await tx.insert(franchiseZonePins).values(pins.map((p) => ({ zoneId: id, pincode: p.pincode }))).onConflictDoNothing();
      if (est) await tx.insert(franchiseZoneEstimates).values({ zoneId: id, estShopCount: Math.trunc(parts[i].shops), gmvPerShopLakh: est.gmvPerShopLakh, asOf: est.asOf, source: `${est.source}; split from zone ${zoneId}`, createdBy: actor.id });
    }
    await tx.update(franchiseZones).set({ status: "RETIRED", statusReason: `Split into ${ids.join(", ")}`, updatedAt: new Date() }).where(eq(franchiseZones.zoneId, zoneId));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_ZONE_CHANGED, entityType: "franchise_zone", entityId: zoneId, previousValue: { status: zone.status, shops: est?.estShopCount ?? null }, newValue: { split: parts.map((p, i) => ({ zoneId: ids[i], name: p.name, shops: p.shops })), reason } }, tx);
    return ids;
  });
}

/**
 * Seeds each zone without a reference point by geocoding the first locality of its name (brief §6),
 * marked "auto – needs review". Never approves anything. Needs GOOGLE_MAPS_SERVER_API_KEY.
 */
export async function autoSeedReferencePoints(actor: Actor, options: { limit?: number } = {}): Promise<{ seeded: string[]; failed: { zoneId: string; error: string }[] }> {
  if (actor.role !== "ADMIN") throw validationFailed("Only an admin can do this.");
  if (!isGeocodingConfigured()) throw conflict("Geocoding is not configured on this server (GOOGLE_MAPS_SERVER_API_KEY).");
  const zones = await zoneViews({ includeTest: false });
  const todo = zones.filter((z) => !z.reference && z.status !== "RETIRED").slice(0, options.limit ?? 100);
  const seeded: string[] = [];
  const failed: { zoneId: string; error: string }[] = [];
  for (const z of todo) {
    const locality = firstLocality(z.name);
    try {
      const hit = await geocodeAddress(`${locality}, Pune, Maharashtra ${z.pinCodes[0] ?? ""}`.trim(), z.zoneId);
      await saveBoundaryDraft(z.zoneId, { ref: { lat: hit.lat, lng: hit.lng, label: `${locality} (auto – needs review)` }, shape: "NONE", source: "AUTO_GEOCODE", note: hit.formatted }, actor);
      seeded.push(z.zoneId);
    } catch (e) {
      failed.push({ zoneId: z.zoneId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { seeded, failed };
}

/** "Mandai & Tulsibaug Market" → "Mandai"; "Camp – MG Road & Aurora Towers Belt" → "Camp". */
export function firstLocality(name: string): string {
  return name.split(/\s*(?:&|,|–|-|\(|\/)\s*/)[0].trim() || name;
}

async function geocodeAddress(address: string, zoneId: string): Promise<{ lat: number; lng: number; formatted: string }> {
  const started = Date.now();
  let success = false;
  let errorMessage: string | null = null;
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("region", "in");
    url.searchParams.set("key", getEnv().GOOGLE_MAPS_SERVER_API_KEY!);
    const res = await fetch(url);
    const body = (await res.json()) as { status: string; results?: { formatted_address: string; geometry: { location: { lat: number; lng: number } } }[]; error_message?: string };
    if (!res.ok || body.status !== "OK" || !body.results?.[0]) throw new Error(body.error_message ?? `Geocoding failed: ${body.status}`);
    success = true;
    const r = body.results[0];
    return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, formatted: r.formatted_address };
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    await db
      .insert(mapsApiCallLog)
      .values({ service: "GEOCODING", purpose: "franchise_zone_reference", entityType: "franchise_zone", entityId: zoneId, success, responseTimeMs: Date.now() - started, errorMessage })
      .catch(() => {});
  }
}

/** GeoJSON of approved boundaries (and reference points) with availability, for the booking map. */
export async function boundariesGeoJson(options: { includeTest?: boolean; includeDrafts?: boolean } = {}): Promise<unknown> {
  const zones = await zoneViews({ includeTest: options.includeTest });
  const byZone = new Map(zones.map((z) => [z.zoneId, z]));
  const rows = await db.select().from(franchiseZoneBoundaries).orderBy(desc(franchiseZoneBoundaries.version));
  const seen = new Set<string>();
  const features: unknown[] = [];
  for (const b of rows) {
    const z = byZone.get(b.zoneId);
    if (!z || seen.has(b.zoneId)) continue;
    if (b.status !== "APPROVED" && !(options.includeDrafts && b.status === "DRAFT")) continue;
    seen.add(b.zoneId);
    const s = shapeOf(b);
    const ring = s ? boundaryRing(s) : [];
    if (ring.length < 3) continue;
    features.push({
      type: "Feature",
      id: z.zoneId,
      properties: { zone_id: z.zoneId, name: z.name, cluster: z.clusterCode, badge: z.badge, slotsFree: z.slotsFree, status: z.status, boundary: b.status, version: b.version },
      geometry: { type: "Polygon", coordinates: [[...ring, ring[0]].map(([lat, lng]) => [lng, lat])] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** An admin-only hidden test zone for the production end-to-end booking (brief §15). Far from Pune's zones. */
export async function ensureTestZone(actor: Actor): Promise<string> {
  if (actor.role !== "ADMIN") throw validationFailed("Only an admin can do this.");
  const zoneId = "T-QA1";
  await db.transaction(async (tx) => {
    await tx
      .insert(franchiseZones)
      .values({ zoneId, regionCode: "PMR", clusterCode: "C7", name: "QA test zone (hidden, admin only)", commercialProfile: "Test", origin: "TEST", status: "BOUNDARY_PENDING", isTest: true, sortKey: 9_999_999 })
      .onConflictDoNothing();
    const [has] = await tx.select({ id: franchiseZoneBoundaries.id }).from(franchiseZoneBoundaries).where(eq(franchiseZoneBoundaries.zoneId, zoneId));
    if (!has) {
      // A 1 km circle in the Arabian Sea off Mumbai: no real shop can ever be inside it.
      await tx.insert(franchiseZoneBoundaries).values({ zoneId, version: 1, refLat: 18.9, refLng: 72.6, refLabel: "QA test point (sea)", shape: "CIRCLE", radiusM: 1000, maxDistanceM: 1000, status: "APPROVED", approvedAt: new Date(), approvedBy: actor.id, createdBy: actor.id });
      await tx.update(franchiseZones).set({ status: "BOOKABLE" }).where(eq(franchiseZones.zoneId, zoneId));
    }
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FRANCHISE_ZONE_CHANGED, entityType: "franchise_zone", entityId: zoneId, newValue: { testZone: true } }, tx);
  });
  return zoneId;
}
