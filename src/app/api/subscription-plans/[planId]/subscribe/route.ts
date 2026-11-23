/** Take a shop's subscription plan (docs/subscription-plans-2026-11). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { isoDateSchema, todayOrLaterDateSchema } from "@/server/api/date-schema";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { subscribeToPlan } from "@/server/services/subscription-plans";

export const dynamic = "force-dynamic";

const schema = z.object({
  quantityMilli: z.number().int().positive().max(100_000),
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  monthDays: z.array(z.number().int().min(1).max(28)).max(28).default([]),
  startDate: todayOrLaterDateSchema,
  endDate: isoDateSchema.nullish(),
  termDays: z.number().int().min(1).max(365).nullish(),
  addressId: z.string().uuid(),
  draft: z.boolean().optional(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ planId: string }>) => {
  const user = await requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE_OWN);
  const { planId } = await context.params;
  z.string().uuid().parse(planId);
  const body = await parseBody(request, schema);
  return ok(await subscribeToPlan({ userId: user.id, planId, ...body, endDate: body.endDate ?? null, termDays: body.termDays ?? null }), 201);
});
