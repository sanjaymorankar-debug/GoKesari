/** Billing v2 (docs/billing §9.8): e-way bill Part B (vehicle), extend, cancel. The shop's owner, or an admin. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess, requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { cancelEwayBill, extendEwayBill, updateEwayPartB } from "@/server/gst/einvoice-extras";
import { requireFeature } from "@/server/services/feature-flags";
import { getInvoice } from "@/server/services/invoices";

const reason = z.enum(["1", "2", "3", "4"]);

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string; action: string }>) => {
  await requireUser();
  await requireFeature("ewaybill");
  const { id: raw, action } = await context.params;
  const id = z.string().uuid().parse(raw);
  const invoice = await getInvoice(id);
  const { user } = await requireShopAccess(invoice.shopId, { anyPermission: PERMISSIONS.STATUTORY_MANAGE });
  if (action === "part-b") {
    const b = await parseBody(request, z.object({ vehicleNo: z.string().trim().min(6).max(15), reason, remark: z.string().trim().max(100).default("") }));
    return ok(await updateEwayPartB(id, b.vehicleNo, b.reason, b.remark, user));
  }
  if (action === "extend") {
    const b = await parseBody(request, z.object({ remainingKm: z.number().int().positive().max(4000), reason: z.enum(["1", "2", "3", "4", "99"]), remark: z.string().trim().max(100).default("") }));
    return ok(await extendEwayBill(id, b.remainingKm, b.reason, b.remark, user));
  }
  if (action === "cancel") {
    const b = await parseBody(request, z.object({ reason, remark: z.string().trim().min(3).max(100) }));
    return ok(await cancelEwayBill(id, b.reason, b.remark, user));
  }
  throw notFound("Endpoint");
});
