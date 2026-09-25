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
 * Stored in an httpOnly cookie; nothing is written to the database, and no
 * reverse-geocoding call is made (MAPS_USAGE.md — no per-visit Maps cost).
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
import { ok, parseBody, route } from "@/server/api/handler";
import { getCurrentUser } from "@/server/authz/guards";
import { unauthenticated } from "@/lib/errors";
import { locationFromAddress } from "@/server/location";
import { getAddress } from "@/server/services/addresses";

const schema = z.union([
  z.object({ addressId: z.string().uuid() }),
  z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    pincode: z.string().regex(/^\d{6}$/).nullish(),
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
    location = {
      label: "Current location",
      pincode: body.pincode ?? null,
      latitude: roundCoordinate(body.latitude),
      longitude: roundCoordinate(body.longitude),
      source: "DEVICE",
      addressId: null,
      societyId: null,
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
  return ok(location);
});

export const DELETE = route(async () => {
  (await cookies()).delete(LOCATION_COOKIE);
  return ok({ cleared: true });
});
