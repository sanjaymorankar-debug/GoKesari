/**
 * The area master for the shop-registration area picker (§5.1). GET ?lat=&lng=&pincode= → suggestions first (PIN
 * match, then nearest), and every area of the enabled zone sets (Unzoned ones included: free teams may register there).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { listAreas, suggestAreas } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

const query = z.object({ lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(), pincode: z.string().regex(/^[1-9][0-9]{5}$/).optional() });

export const GET = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "franchise-areas"), { limit: 120, windowMs: 60_000 });
  const q = parseQuery(request, query);
  const suggestions = await suggestAreas({ lat: q.lat ?? null, lng: q.lng ?? null, pincode: q.pincode ?? null });
  const areas = (await listAreas()).map((a) => ({ id: a.id, name: a.name, region: a.region, zoneId: a.zoneId, zoneName: a.zoneName }));
  return ok({ suggestions: suggestions.map((a) => ({ id: a.id, name: a.name, region: a.region, zoneId: a.zoneId, zoneName: a.zoneName, distanceM: a.distanceM, pinMatch: a.pinMatch })), areas });
});
