/**
 * The rider's insurance nominee (Rider App v2, rule riderInsurance).
 *   PUT {name, relation, mobile?, dateOfBirth? (YYYY-MM-DD)} → {name, relation, mobile, dateOfBirth} (audited)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { saveMyNominee } from "@/server/services/rider-insurance";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().max(120),
  relation: z.string().max(40),
  mobile: z.string().max(15).nullish(),
  dateOfBirth: z.string().max(10).nullish(),
});

export const PUT = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  enforceRateLimit(`rider-nominee:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await saveMyNominee(user, body));
});
