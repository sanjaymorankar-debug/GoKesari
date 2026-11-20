/**
 * Newspaper and periodical subscriptions (docs/newspaper-subscriptions-2026-11).
 * GET: every title. POST: subscribe to several titles from one vendor in one go.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { isoDateSchema, todayOrLaterDateSchema } from "@/server/api/date-schema";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listPeriodicalTitles, MAX_COPIES, subscribeToNewspapers } from "@/server/services/newspaper-subscriptions";

export const dynamic = "force-dynamic";

export const GET = route(async () => ok(await listPeriodicalTitles()));

const itemSchema = z.object({
  shopProductId: z.string().uuid(),
  copies: z.number().int().min(1).max(MAX_COPIES).default(1),
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  monthDays: z.array(z.number().int().min(1).max(28)).max(28).default([]),
});

const createSchema = z.object({
  shopId: z.string().uuid(),
  addressId: z.string().uuid(),
  // A real date, today or later (the same rule as a single subscription).
  startDate: todayOrLaterDateSchema,
  endDate: isoDateSchema.nullish(),
  items: z.array(itemSchema).min(1).max(20),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE_OWN);
  const body = await parseBody(request, createSchema);
  const created = await subscribeToNewspapers({
    userId: user.id,
    shopId: body.shopId,
    addressId: body.addressId,
    startDate: body.startDate,
    endDate: body.endDate ?? null,
    items: body.items,
  });
  return ok({ bundleId: created[0]?.bundleId ?? null, subscriptions: created }, 201);
});
