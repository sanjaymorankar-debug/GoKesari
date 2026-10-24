/** List and create subscriptions (requirements §25, §26). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { isoDateSchema, todayOrLaterDateSchema } from "@/server/api/date-schema";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import {
  createSubscription,
  listSubscriptionsForUser,
} from "@/server/services/subscriptions";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE_OWN);
  return ok(await listSubscriptionsForUser(user.id));
});

const createSchema = z.object({
  shopProductId: z.string().uuid(),
  /** Milli-units: 2 L/day is 2000. Keeps 0.5 steps exact. */
  quantityMilli: z.number().int().positive().max(100_000),
  frequency: z.enum(["DAILY", "WEEKLY"]).default("DAILY"),
  weekdays: z.array(z.number().int().min(1).max(7)).default([]),
  // TC-FLD-108: a real date, today or later (blank, "2026-02-31", text → 422; yesterday refused).
  startDate: todayOrLaterDateSchema,
  endDate: isoDateSchema.nullish(),
  addressId: z.string().uuid().nullish(),
  /** SM-004: save without starting. */
  draft: z.boolean().optional(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE_OWN);
  const body = await parseBody(request, createSchema);

  const subscription = await createSubscription({
    userId: user.id,
    shopProductId: body.shopProductId,
    quantityMilli: body.quantityMilli,
    frequency: body.frequency,
    weekdays: body.weekdays,
    startDate: body.startDate,
    endDate: body.endDate ?? null,
    addressId: body.addressId ?? null,
    draft: body.draft ?? false,
  });

  return ok(subscription, 201);
});
