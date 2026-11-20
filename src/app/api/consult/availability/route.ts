/** GET ?serviceId&memberId&from=YYYY-MM-DD&days=7&attendees=1 — free times of a service, per IST day. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireConsultEnabled } from "@/server/consult/access";
import { publicAvailability } from "@/server/consult/discovery";

export const dynamic = "force-dynamic";

const query = z.object({
  serviceId: z.string().uuid(),
  memberId: z.string().uuid().optional(),
  from: z.string().default(""),
  days: z.coerce.number().int().min(1).max(14).default(7),
  attendees: z.coerce.number().int().min(1).max(500).default(1),
});

export const GET = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "consult-availability"), RATE_LIMITS.SEARCH_SUGGEST);
  await requireConsultEnabled();
  const q = parseQuery(request, query);
  return ok(await publicAvailability({ serviceId: q.serviceId, memberId: q.memberId ?? null, from: q.from, days: q.days, attendees: q.attendees }));
});
