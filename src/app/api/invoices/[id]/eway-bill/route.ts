/**
 * POST { distanceKm, vehicleNo? } → e-way bill for the invoice through the
 * GSP, when the value rules say one is needed. The shop's owner and operations.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { generateEwayBill, gstDocumentsFor } from "@/server/gst/einvoice";
import { getInvoice } from "@/server/services/invoices";

export const dynamic = "force-dynamic";

const schema = z.object({ distanceKm: z.number().int().min(1).max(4000), vehicleNo: z.string().trim().max(15).optional() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const invoice = await getInvoice(id);
  const { user } = await requireShopAccess(invoice.shopId, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  enforceRateLimit(`eway-bill:${user.id}`, { limit: 30, windowMs: 10 * 60_000 });
  await generateEwayBill(id, await parseBody(request, schema), user);
  return ok(await gstDocumentsFor(id), 201);
});
