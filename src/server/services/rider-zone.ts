/**
 * "My Zone" for a rider (Rider App v2): where they work, the societies that listed or authorised
 * them, where orders are coming from right now and any live surge.
 *
 * Privacy: hot-spots are counts per PIN code / area only, with the area's centre rounded to two
 * decimals (about 1 km) — never a customer's name, phone, address, order value or fee.
 */
import { and, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";

import { haversineDistanceKm, parseCoordinates } from "@/lib/geo/haversine";
import { db } from "@/server/db";
import { deliveryPartners, orders, societies, societyPartnerAccess, societyRiders } from "@/server/db/schema";
import { liveSurges } from "./rider-pay-plans";

const HOTSPOT_WINDOW_MIN = 60;
/** Live position counts when shared in the last 30 minutes; otherwise the registered base. */
const LIVE_POSITION_MAX_AGE_MS = 30 * 60_000;

export interface ZoneView {
  centre: { latitude: number; longitude: number } | null;
  centreSource: "LIVE" | "REGISTERED" | null;
  radiusKm: number;
  societies: { id: string; name: string; area: string | null; city: string; latitude: number | null; longitude: number | null; distanceKm: number | null }[];
  hotspots: { key: string; label: string; pincode: string; orders: number; latitude: number | null; longitude: number | null; distanceKm: number | null }[];
  surges: { label: string; multiplierBp: number; flatPaise: number; endsAt: string }[];
  windowMinutes: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function getRiderZone(partnerId: string, now: Date = new Date()): Promise<ZoneView> {
  const partner = await db.query.deliveryPartners.findFirst({
    where: and(eq(deliveryPartners.id, partnerId), isNull(deliveryPartners.deletedAt)),
    columns: {
      latitude: true,
      longitude: true,
      lastLocationLatitude: true,
      lastLocationLongitude: true,
      lastLocationAt: true,
      operatingRadiusKm: true,
      addressCity: true,
    },
  });
  const radiusKm = partner?.operatingRadiusKm ?? 5;
  const live =
    partner?.lastLocationAt && now.getTime() - partner.lastLocationAt.getTime() <= LIVE_POSITION_MAX_AGE_MS
      ? parseCoordinates(partner.lastLocationLatitude, partner.lastLocationLongitude)
      : null;
  const registered = partner ? parseCoordinates(partner.latitude, partner.longitude) : null;
  const centre = live ?? registered;
  const centreSource = live ? "LIVE" : registered ? "REGISTERED" : null;
  const distance = (lat: number | null, lng: number | null) =>
    centre && lat != null && lng != null ? Math.round(haversineDistanceKm(centre, { latitude: lat, longitude: lng }) * 10) / 10 : null;

  // Societies: listed by the society (active) or authorised by GoKesari, verified, not blocked.
  const [listed, authorised, blocked] = await Promise.all([
    db
      .select({ id: societyRiders.societyId })
      .from(societyRiders)
      .where(and(eq(societyRiders.deliveryPartnerId, partnerId), eq(societyRiders.status, "ACTIVE"))),
    db
      .select({ id: societyPartnerAccess.societyId })
      .from(societyPartnerAccess)
      .where(and(eq(societyPartnerAccess.deliveryPartnerId, partnerId), eq(societyPartnerAccess.access, "AUTHORISED"))),
    db
      .select({ id: societyPartnerAccess.societyId })
      .from(societyPartnerAccess)
      .where(and(eq(societyPartnerAccess.deliveryPartnerId, partnerId), eq(societyPartnerAccess.access, "BLOCKED"))),
  ]);
  const blockedIds = new Set(blocked.map((b) => b.id));
  const societyIds = [...new Set([...listed, ...authorised].map((r) => r.id))].filter((id) => !blockedIds.has(id));
  const societyRows =
    societyIds.length === 0
      ? []
      : await db
          .select({
            id: societies.id,
            name: societies.name,
            area: societies.area,
            city: societies.city,
            latitude: societies.latitude,
            longitude: societies.longitude,
          })
          .from(societies)
          .where(and(inArray(societies.id, societyIds), eq(societies.status, "VERIFIED"), isNull(societies.deletedAt)));
  const societyList = societyRows
    .map((s) => {
      const p = parseCoordinates(s.latitude, s.longitude);
      return { id: s.id, name: s.name, area: s.area, city: s.city, latitude: p?.latitude ?? null, longitude: p?.longitude ?? null, distanceKm: distance(p?.latitude ?? null, p?.longitude ?? null) };
    })
    .sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));

  // Demand hot-spots: orders placed in the last hour, grouped by the drop's PIN code and area.
  const since = new Date(now.getTime() - HOTSPOT_WINDOW_MIN * 60_000);
  const pincode = sql<string>`${orders.deliveryAddressSnapshot}->>'pincode'`;
  const area = sql<string | null>`nullif(trim(${orders.deliveryAddressSnapshot}->>'area'), '')`;
  const grouped = await db
    .select({
      pincode,
      area,
      n: sql<number>`count(*)::int`,
      lat: sql<number | null>`avg(nullif(${orders.deliveryAddressSnapshot}->>'latitude', '')::double precision)`,
      lng: sql<number | null>`avg(nullif(${orders.deliveryAddressSnapshot}->>'longitude', '')::double precision)`,
    })
    .from(orders)
    .where(
      and(
        gte(orders.createdAt, since),
        notInArray(orders.status, ["CANCELLED", "PAYMENT_FAILED", "WALLET_INSUFFICIENT"]),
        sql`${orders.deliveryAddressSnapshot}->>'pincode' is not null`,
      ),
    )
    .groupBy(pincode, area);
  // Near the rider: within twice their working radius (they may ride over); unplaced areas are left out.
  const reach = radiusKm * 2;
  const hotspots = grouped
    .map((g) => {
      const lat = g.lat != null && Number.isFinite(Number(g.lat)) ? round2(Number(g.lat)) : null;
      const lng = g.lng != null && Number.isFinite(Number(g.lng)) ? round2(Number(g.lng)) : null;
      return {
        key: `${g.pincode}|${g.area ?? ""}`,
        label: g.area ? `${g.area} (${g.pincode})` : g.pincode,
        pincode: g.pincode,
        orders: Number(g.n),
        latitude: lat,
        longitude: lng,
        distanceKm: distance(lat, lng),
      };
    })
    .filter((h) => h.distanceKm != null && h.distanceKm <= reach)
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 20);

  const surges = centre || partner?.addressCity ? await liveSurges({ city: partner?.addressCity ?? null, point: centre }, now) : [];
  return {
    centre,
    centreSource,
    radiusKm,
    societies: societyList,
    hotspots,
    surges: surges.map((s) => ({
      label: s.note?.trim() || s.reason,
      multiplierBp: s.multiplierBp,
      flatPaise: s.flatPaise,
      endsAt: s.endsAt.toISOString(),
    })),
    windowMinutes: HOTSPOT_WINDOW_MIN,
  };
}
