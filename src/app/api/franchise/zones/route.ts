/**
 * Public: the franchise zones (final brief 21-Nov-2026 §5.4–§5.5) with tier, fee, % vs average, business figure and
 * source, areas, description, status badge and slots, filtered on the server; plus the region / tier facets and the
 * offer (launch places, GST, provisional-sale switch). Only enabled zone sets; Inactive zones are hidden.
 * GET ?region=&tier=PREMIER|STANDARD|EMERGING&slots=available|1&feeMin=&feeMax=(rupees)&status=&q=&test=1
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ZONE_STATUSES, ZONE_TIERS } from "@/lib/franchise";
import { ok, parseQuery, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { getCurrentUser } from "@/server/authz/guards";
import { offerView } from "@/server/franchise/booking";
import { filterZones, zoneFacets, zoneViews } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

const rupees = z.coerce.number().min(0).max(100_000_000).optional();
const query = z.object({
  q: z.string().max(80).optional(),
  region: z.string().max(40).optional(),
  tier: z.enum([...ZONE_TIERS, "ALL"]).optional(),
  slots: z.enum(["available", "1", "any"]).optional(),
  status: z.enum([...ZONE_STATUSES, "ALL"]).optional(),
  feeMin: rupees,
  feeMax: rupees,
  test: z.enum(["1"]).optional(),
});

export const GET = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "franchise-zones"), { limit: 120, windowMs: 60_000 });
  const f = parseQuery(request, query);
  const user = f.test ? await getCurrentUser() : null;
  const all = await zoneViews({ includeTest: user?.role === "ADMIN" });
  const zones = filterZones(all, { ...f, feeMinPaise: f.feeMin != null ? f.feeMin * 100 : undefined, feeMaxPaise: f.feeMax != null ? f.feeMax * 100 : undefined });
  return ok({ zones, facets: zoneFacets(all), offer: await offerView() });
});
