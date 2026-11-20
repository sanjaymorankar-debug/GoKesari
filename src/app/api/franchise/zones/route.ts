/**
 * Public: the Pune PMR zones with availability and estimates (brief §4.2–4.3), searched, filtered and sorted
 * on the server, plus the cluster summary and the offer (fee, launch places left). Only enabled regions.
 * GET ?q=&cluster=C1&availability=2|1|0&minAnnualCr=&maxAnnualCr=&profile=&origin=ORIGINAL|SPLIT&sort=annual|shops|zone
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ESTIMATE_DISCLOSURE } from "@/lib/franchise";
import { ok, parseQuery, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { getCurrentUser } from "@/server/authz/guards";
import { offerView } from "@/server/franchise/booking";
import { clusterSummary, filterZones, listClusters, zoneViews } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

const num = z.coerce.number().min(0).max(1_000_000).optional();
const query = z.object({
  q: z.string().max(80).optional(),
  cluster: z.string().max(8).optional(),
  availability: z.enum(["2", "1", "0"]).optional(),
  minAnnualCr: num,
  maxAnnualCr: num,
  profile: z.string().max(80).optional(),
  origin: z.enum(["ORIGINAL", "SPLIT"]).optional(),
  sort: z.enum(["annual", "shops", "zone"]).optional(),
  test: z.enum(["1"]).optional(),
});

export const GET = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "franchise-zones"), { limit: 120, windowMs: 60_000 });
  const f = parseQuery(request, query);
  const user = f.test ? await getCurrentUser() : null;
  const all = await zoneViews({ includeTest: user?.role === "ADMIN" });
  const clusters = await listClusters();
  return ok({ zones: filterZones(all, f), clusters: clusterSummary(all, clusters), offer: await offerView(), disclosure: ESTIMATE_DISCLOSURE });
});
