/** Operations: referral-code requests (?status=NEW|CODE_ISSUED|REJECTED). REFERRAL_MANAGE. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { REFERRAL_REQUEST_STATUSES } from "@/server/db/schema";
import { listReferralRequests } from "@/server/services/referral-requests";

export const dynamic = "force-dynamic";

const schema = z.object({ status: z.enum(REFERRAL_REQUEST_STATUSES).optional() });

export const GET = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.REFERRAL_MANAGE);
  const { status } = parseQuery(request, schema);
  return ok({ requests: await listReferralRequests(status ?? null, user) });
});
