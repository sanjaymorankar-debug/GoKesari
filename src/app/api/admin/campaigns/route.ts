/** Campaign review queue (WF-009). MARKETING_APPROVE (operator, admin). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { campaignStatusEnum } from "@/server/db/schema";
import { listCampaignsForReview } from "@/server/services/marketing";

export const dynamic = "force-dynamic";

const schema = z.object({ status: z.enum(campaignStatusEnum.enumValues).optional() });

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.MARKETING_APPROVE);
  const { status } = parseQuery(request, schema);
  return ok(await listCampaignsForReview(status));
});
