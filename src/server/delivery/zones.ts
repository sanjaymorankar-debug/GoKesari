/**
 * Configurable delivery zones (docs/hdms-2026-11). Boundaries live in delivery_zones (circle or polygon),
 * never in code. A suspended zone takes no new partner bookings until resumed (or suspended_until passes).
 */
import { asc, eq } from "drizzle-orm";

import { conflict, notFound } from "@/lib/errors";
import { db } from "@/server/db";
import { deliveryZones, type DeliveryZone } from "@/server/db/hdms-schema";

import { haversineMeters, pointInPolygon } from "./geo";
import type { GeoPoint } from "./providers/types";

export function zoneContains(zone: Pick<DeliveryZone, "centerLat" | "centerLng" | "radiusM" | "polygon">, p: GeoPoint): boolean {
  if (zone.polygon && zone.polygon.length >= 3) return pointInPolygon(p, zone.polygon);
  return haversineMeters({ lat: Number(zone.centerLat), lng: Number(zone.centerLng) }, p) <= zone.radiusM;
}

export function zoneIsOpen(zone: Pick<DeliveryZone, "status" | "suspendedUntil">, now = new Date()): boolean {
  if (zone.status === "ACTIVE") return true;
  return zone.suspendedUntil != null && zone.suspendedUntil.getTime() <= now.getTime();
}

/** The zone a point falls in: the nearest centre among the zones that contain it. */
export function pickZone(zones: DeliveryZone[], p: GeoPoint): DeliveryZone | null {
  const inside = zones.filter((z) => zoneContains(z, p));
  if (inside.length === 0) return null;
  return inside.sort(
    (a, b) =>
      haversineMeters({ lat: Number(a.centerLat), lng: Number(a.centerLng) }, p) -
      haversineMeters({ lat: Number(b.centerLat), lng: Number(b.centerLng) }, p),
  )[0];
}

export async function listZones(): Promise<DeliveryZone[]> {
  return db.select().from(deliveryZones).orderBy(asc(deliveryZones.city), asc(deliveryZones.name));
}

export async function zoneForPoint(p: GeoPoint): Promise<DeliveryZone | null> {
  return pickZone(await listZones(), p);
}

export interface ZoneInput {
  code: string;
  name: string;
  city: string;
  centerLat: number;
  centerLng: number;
  radiusM: number;
  polygon?: [number, number][] | null;
  maxDeliveryKm: number;
}

export async function saveZone(id: string | null, input: ZoneInput, actorId: string): Promise<DeliveryZone> {
  const values = {
    code: input.code.trim().toUpperCase(),
    name: input.name.trim(),
    city: input.city.trim(),
    centerLat: input.centerLat.toFixed(6),
    centerLng: input.centerLng.toFixed(6),
    radiusM: input.radiusM,
    polygon: input.polygon && input.polygon.length >= 3 ? input.polygon : null,
    maxDeliveryKm: input.maxDeliveryKm.toFixed(2),
    updatedBy: actorId,
    updatedAt: new Date(),
  };
  if (id) {
    const [row] = await db.update(deliveryZones).set(values).where(eq(deliveryZones.id, id)).returning();
    if (!row) throw notFound("Zone");
    return row;
  }
  const [row] = await db.insert(deliveryZones).values(values).onConflictDoNothing().returning();
  if (!row) throw conflict(`A zone with code ${values.code} already exists.`);
  return row;
}

export async function setZoneSuspended(
  id: string,
  suspend: { reason: string; until: Date | null } | null,
  actorId: string,
): Promise<DeliveryZone> {
  const [row] = await db
    .update(deliveryZones)
    .set(
      suspend
        ? { status: "SUSPENDED", suspendedReason: suspend.reason, suspendedUntil: suspend.until, updatedBy: actorId, updatedAt: new Date() }
        : { status: "ACTIVE", suspendedReason: null, suspendedUntil: null, updatedBy: actorId, updatedAt: new Date() },
    )
    .where(eq(deliveryZones.id, id))
    .returning();
  if (!row) throw notFound("Zone");
  return row;
}
