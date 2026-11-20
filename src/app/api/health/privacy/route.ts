/** POST { kind: EXPORT|DELETE, note? } → a DPDP data request (DELETE hides my records at once; medical records are retained). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { bodyOf } from "@/server/health/http";
import { requestDataAction } from "@/server/health/patients";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`health-privacy:${user.id}`, RATE_LIMITS.MUTATION);
  const body = z.object({ kind: z.enum(["EXPORT", "DELETE"]), note: z.string().trim().max(500).nullish() }).parse(await bodyOf(request));
  return ok(await requestDataAction(body.kind, user, body.note ?? null), 201);
});
