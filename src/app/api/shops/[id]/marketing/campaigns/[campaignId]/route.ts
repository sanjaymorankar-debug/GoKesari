/**
 * Owner actions on one campaign (WF-009): edit (draft / rejected), submit
 * for approval, send (approved), or cancel.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopMarketing } from "@/server/authz/marketing-access";
import { cancelCampaign, saveCampaign, sendCampaign, submitCampaign } from "@/server/services/marketing";
import { campaignSchema } from "@/server/api/marketing-schemas";

const schema = z.discriminatedUnion("action", [
  campaignSchema.extend({ action: z.literal("update") }),
  z.object({ action: z.literal("submit") }),
  z.object({ action: z.literal("send") }),
  z.object({ action: z.literal("cancel") }),
]);

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string; campaignId: string }>) => {
  const { id, campaignId } = await context.params;
  const user = await requireShopMarketing(id, "manage");
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "update": {
      const { action: _action, ...input } = body;
      void _action;
      return ok(await saveCampaign(id, { ...input, id: campaignId }, user));
    }
    case "submit":
      return ok(await submitCampaign(id, campaignId, user));
    case "send":
      return ok(await sendCampaign(id, campaignId, user));
    case "cancel":
      return ok(await cancelCampaign(id, campaignId, user));
  }
});
