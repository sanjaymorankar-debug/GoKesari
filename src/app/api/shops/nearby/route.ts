/**
 * Nearby shops (docs/nearby-referral-2026-10, feature 1). Public — signed-out
 * visitors can use Nearby too — and rate-limited per IP.
 *
 * GET ?lat=18.55&lng=73.94&radiusKm=5     from the device's position
 * GET ?q=411014&radiusKm=5                 from a typed PIN code or area (location refused / unavailable)
 *
 * radiusKm is 1, 3, 5 or 10 (default 5). Answers
 *   { origin: { latitude, longitude, source: "DEVICE" | "PLACE", place: { area, city, pincode } | null },
 *     radiusKm, countsByRadius: { 1, 3, 5, 10 }, shops: [...] }
 * with approved live shops nearest first, distance worked out on the server
 * (Haversine). 404 when a typed place cannot be found.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { AppError } from "@/lib/errors";
import { parseNearbyRadius } from "@/lib/geo/nearby";
import { parseQuery, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { findNearbyShops, isValidPosition } from "@/server/services/nearby-shops";
import { describePosition, findPlace } from "@/server/services/place-lookup";

export const dynamic = "force-dynamic";

const querySchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    q: z.string().trim().min(2, "Enter a PIN code or an area.").max(80).optional(),
    radiusKm: z.string().optional(),
  })
  .refine((v) => (v.lat != null && v.lng != null) || v.q, { message: "Send a position (lat, lng) or a PIN code / area (q).", path: ["q"] });

export const GET = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "shops-nearby"), { limit: 60, windowMs: 60_000 });
  const query = parseQuery(request, querySchema);
  const radiusKm = parseNearbyRadius(query.radiusKm);

  let origin: { latitude: number; longitude: number };
  let source: "DEVICE" | "PLACE";
  let place: { area: string | null; city: string | null; pincode: string | null } | null;
  if (query.lat != null && query.lng != null && isValidPosition(query.lat, query.lng)) {
    origin = { latitude: query.lat, longitude: query.lng };
    source = "DEVICE";
    place = await describePosition(query.lat, query.lng).catch(() => null);
  } else {
    const found = query.q ? await findPlace(query.q) : null;
    if (!found) throw new AppError("NOT_FOUND", "We couldn't find that PIN code or area. Check it, or try a nearby PIN code.");
    origin = { latitude: found.latitude, longitude: found.longitude };
    source = "PLACE";
    place = { area: found.area, city: found.city, pincode: found.pincode };
  }

  const result = await findNearbyShops(origin, radiusKm);
  return NextResponse.json(
    { ...result, origin: { ...result.origin, source, place } },
    { headers: { "cache-control": "no-store" } },
  );
});
