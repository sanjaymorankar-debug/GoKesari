/** POST → generate (or retry) the invoice's e-invoice (IRN) through the GSP. The shop's owner and operations. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { gstDocumentsFor, requestEinvoice } from "@/server/gst/einvoice";
import { getInvoice } from "@/server/services/invoices";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const invoice = await getInvoice(id);
  const { user } = await requireShopAccess(invoice.shopId, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  enforceRateLimit(`einvoice:${user.id}`, { limit: 30, windowMs: 10 * 60_000 });
  await requestEinvoice(id);
  return ok(await gstDocumentsFor(id));
});
