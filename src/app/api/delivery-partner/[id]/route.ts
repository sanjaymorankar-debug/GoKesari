/** Admin/operator delivery-partner verification actions (delivery-system Slice B). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { toStaffPartnerView } from "@/server/services/delivery-partner-kyc";
import {
  approveDeliveryPartner,
  deactivateDeliveryPartner,
  getDeliveryPartnerById,
  reactivateDeliveryPartner,
  rejectDeliveryPartner,
  startDeliveryPartnerReview,
  suspendDeliveryPartner,
} from "@/server/services/delivery-partners";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start_review"), notes: z.string().max(1000).nullish() }),
  z.object({ action: z.literal("approve"), notes: z.string().max(1000).nullish() }),
  z.object({ action: z.literal("reject"), reason: z.string().min(3).max(1000) }),
  z.object({ action: z.literal("suspend"), reason: z.string().min(3).max(1000) }),
  z.object({ action: z.literal("reactivate") }),
  z.object({ action: z.literal("deactivate"), reason: z.string().min(3).max(1000) }),
]);

export const GET = route(
  async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
    await requirePermission(PERMISSIONS.DELIVERY_PARTNER_MANAGE);
    const { id } = await context.params;
    return ok(toStaffPartnerView(await getDeliveryPartnerById(id)));
  },
);

export const PATCH = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_MANAGE);
    const { id } = await context.params;
    const body = await parseBody(request, schema);

    switch (body.action) {
      case "start_review":
        return ok(toStaffPartnerView(await startDeliveryPartnerReview(id, user, body.notes)));
      case "approve":
        return ok(toStaffPartnerView(await approveDeliveryPartner(id, user, body.notes)));
      case "reject":
        return ok(toStaffPartnerView(await rejectDeliveryPartner(id, body.reason, user)));
      case "suspend":
        return ok(toStaffPartnerView(await suspendDeliveryPartner(id, body.reason, user)));
      case "reactivate":
        return ok(toStaffPartnerView(await reactivateDeliveryPartner(id, user)));
      case "deactivate":
        return ok(toStaffPartnerView(await deactivateDeliveryPartner(id, body.reason, user)));
    }
  },
);
