/**
 * PUT { applicable, turnoverBand } → the shop declares whether e-invoicing
 * applies to it (aggregate turnover above the gst_rules threshold). GoKesari
 * sees only its own share of the shop's sales, so the shop (or its CA) says.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { declareEinvoice, einvoiceDeclarationSchema } from "@/server/gst/config";

export const dynamic = "force-dynamic";

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  await declareEinvoice(id, await parseBody(request, einvoiceDeclarationSchema), user);
  return noContent();
});
