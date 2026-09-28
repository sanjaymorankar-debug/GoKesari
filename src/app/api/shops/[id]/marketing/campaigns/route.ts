/** A shop's campaigns with their results (GS-053, WF-009); create a draft. */
import type { NextRequest } from "next/server";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopMarketing } from "@/server/authz/marketing-access";
import { campaignSchema } from "@/server/api/marketing-schemas";
import { listShopCampaigns, saveCampaign } from "@/server/services/marketing";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireShopMarketing(id, "view");
  return ok(await listShopCampaigns(id));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireShopMarketing(id, "manage");
  const body = await parseBody(request, campaignSchema);
  return ok(await saveCampaign(id, body, user), 201);
});
