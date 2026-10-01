/** Edit or switch off one incentive rule. Awards already paid are unaffected. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { saveIncentive } from "@/server/services/rider-earnings-config";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour).");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

const incentiveSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).nullish(),
  type: z.enum(["ORDER_COUNT", "DAILY_TARGET", "WEEKLY_TARGET", "DISTANCE", "PEAK_HOUR", "CAMPAIGN"]),
  thresholdValue: z.number().int().min(0).optional(),
  rewardPaise: z.number().int().min(1),
  period: z.enum(["DAY", "WEEK"]).optional(),
  startTime: hhmm.nullish(),
  endTime: hhmm.nullish(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  validFrom: date.nullish(),
  validTo: date.nullish(),
  isActive: z.boolean().optional(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
  const { id } = await context.params;
  return ok(await saveIncentive(await parseBody(request, incentiveSchema), user, id));
});
