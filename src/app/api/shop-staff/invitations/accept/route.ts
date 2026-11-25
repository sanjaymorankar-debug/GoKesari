/**
 * Module 10: accept an invitation to a shop's staff.
 *   POST { token }    from the e-mailed link (the e-mail address must be the signed-in account's), or
 *   POST { staffId }  an invitation to this account.
 * Signed in by the normal e-mailed code first; the invitation then becomes ACTIVE.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { acceptShopStaffInvite } from "@/server/services/shop-staff";

export const dynamic = "force-dynamic";

const schema = z.union([
  z.object({ token: z.string().min(20).max(200) }).strict(),
  z.object({ staffId: z.string().uuid() }).strict(),
]);

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`shop-staff-accept:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await acceptShopStaffInvite(body, user));
});
