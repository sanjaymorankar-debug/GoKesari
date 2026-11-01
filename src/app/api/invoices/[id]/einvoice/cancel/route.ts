/** Billing v2 (docs/billing §9.7): cancel the invoice's IRN within 24 hours. The shop's owner, or an admin. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess, requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { cancelEinvoice } from "@/server/gst/einvoice-extras";
import { gstDocumentsFor } from "@/server/gst/einvoice";
import { requireFeature, requireFeatureForShop } from "@/server/services/feature-flags";
import { getInvoice } from "@/server/services/invoices";

const body = z.object({ reason: z.enum(["1", "2", "3", "4"]), remark: z.string().trim().min(3).max(100) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireUser();
  await requireFeature("einvoice");
  const id = z.string().uuid().parse((await context.params).id);
  const invoice = await getInvoice(id);
  const { user } = await requireShopAccess(invoice.shopId, { anyPermission: PERMISSIONS.STATUTORY_MANAGE });
  await requireFeatureForShop("einvoice", invoice.shopId);
  const input = await parseBody(request, body);
  await cancelEinvoice(id, input.reason, input.remark, user);
  return ok(await gstDocumentsFor(id));
});
