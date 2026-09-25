/**
 * Report a problem with one of your own orders (GS-056 / WF-007). Creates a
 * grievance linked to the order; operations resolve it and, where due,
 * refund through the finance refund flow.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { eq } from "drizzle-orm";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { orders } from "@/server/db/schema";
import { submitGrievance } from "@/server/services/grievances";

const schema = z.object({
  category: z.enum(["ORDER", "PRODUCT", "PAYMENT"]),
  description: z.string().min(10).max(2000),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.ORDER_VIEW_OWN);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  const order = await db.query.orders.findFirst({ where: eq(orders.id, id), columns: { userId: true, orderNumber: true } });
  if (!order || order.userId !== user.id) throw notFound("Order");
  const grievance = await submitGrievance({
    name: user.name ?? user.email,
    email: user.email,
    category: body.category,
    subject: `Problem with order ${order.orderNumber}`,
    description: body.description,
    submittedByUserId: user.id,
    orderId: id,
  });
  return ok({ ticketNumber: grievance.ticketNumber }, 201);
});
