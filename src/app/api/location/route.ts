/**
 * Choose the delivery location used for shop/product discovery (GS-004).
 *
 * POST one of:
 *   { addressId }              — a saved address of the signed-in user
 *   { latitude, longitude }    — the device's position (browser geolocation)
 *   { pincode }                — a typed 6-digit PIN code
 * DELETE clears the choice (discovery falls back to the default address, or
 * to showing every shop).
 *
 * A device position is labelled with its approximate street address from
 * OpenStreetMap ("12 Lane 5, Kharadi, Pune 411014" — free, no Google call;
 * one request per spot, remembered for a day — MAPS_USAGE.md). Otherwise with
 * the area and city of the nearest shop or saved address within 2 km
 * ("Kharadi, Pune"), from GoKesari's own data; "Current location" only when
 * nothing is known there. No PIN code is saved from either: both are
 * approximate, and discovery goes by distance. With `ifUnset: true` (the automatic detection) a location
 * already chosen, or the signed-in customer's saved address, is kept and the
 * answer says `saved: false`.
 *
 * Stored in an httpOnly cookie; nothing is written to the database.
 */
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { z } from "zod";

import {
  LOCATION_COOKIE,
  LOCATION_COOKIE_MAX_AGE_SECONDS,
  roundCoordinate,
  serializeLocation,
  type CustomerLocation,
} from "@/lib/location";
import { placeLine } from "@/lib/geo/nearby";
import { ok, parseBody, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { getCurrentUser } from "@/server/authz/guards";
import { unauthenticated } from "@/lib/errors";
import { getCustomerLocation, locationFromAddress } from "@/server/location";
import { getAddress } from "@/server/services/addresses";
import { addressForPosition, describePosition } from "@/server/services/place-lookup";

const schema = z.union([
  z.object({ addressId: z.string().uuid() }),
  z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    pincode: z.string().regex(/^\d{6}$/).nullish(),
    /** Set when the customer picked the point by searching an address. */
    label: z.string().min(1).max(120).nullish(),
    /** The automatic detection: keep a location that is already chosen. */
    ifUnset: z.boolean().optional(),
  }),
  z.object({ pincode: z.string().regex(/^\d{6}$/, "Enter a valid 6-digit PIN code.") }),
]);

export const POST = route(async (request: NextRequest) => {
  const body = await parseBody(request, schema);
  let location: CustomerLocation;

  if ("addressId" in body) {
    const user = await getCurrentUser();
    if (!user) throw unauthenticated();
    location = locationFromAddress(await getAddress(user.id, body.addressId));
  } else if ("latitude" in body) {
    enforceRateLimit(clientKey(request, "location-device"), { limit: 30, windowMs: 60_000 });
    if (body.ifUnset) {
      const current = await getCustomerLocation((await getCurrentUser())?.id);
      if (current) return ok({ ...current, saved: false });
    }
    // The approximate street address from OpenStreetMap; else the area and city of the nearest known point.
    const osm = body.label ? null : await addressForPosition(body.latitude, body.longitude).catch(() => null);
    const named = body.label || osm ? null : await describePosition(body.latitude, body.longitude, { ownDataOnly: true }).catch(() => null);
    const area = (osm ? (osm.area ?? osm.city) : (named?.area ?? named?.city))?.slice(0, 80) || null;
    location = {
      label: body.label ?? osm?.address ?? placeLine(named ? { area: named.area, city: named.city } : null)?.slice(0, 120) ?? "Current location",
      pincode: body.pincode ?? null,
      latitude: roundCoordinate(body.latitude),
      longitude: roundCoordinate(body.longitude),
      source: "DEVICE",
      addressId: null,
      societyId: null,
      area,
    };
  } else {
    location = {
      label: `PIN ${body.pincode}`,
      pincode: body.pincode,
      latitude: null,
      longitude: null,
      source: "PINCODE",
      addressId: null,
      societyId: null,
    };
  }

  (await cookies()).set(LOCATION_COOKIE, serializeLocation(location), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: LOCATION_COOKIE_MAX_AGE_SECONDS,
    path: "/",
  });
  return ok({ ...location, saved: true });
});

export const DELETE = route(async () => {
  (await cookies()).delete(LOCATION_COOKIE);
  return ok({ cleared: true });
});
