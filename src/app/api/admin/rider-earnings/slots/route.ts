/** Rider earning slots (Morning / Evening / custom range), each with its own rates. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listSlots, saveSlot } from "@/server/services/rider-earnings-config";

export const dynamic = "force-dynamic";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour).");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const paise = z.number().int().min(0);

const slotSchema = z.object({
  name: z.string().min(1).max(60),
  startTime: hhmm,
  endTime: hhmm,
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  baseFeePaise: paise.nullish(),
  perKmFeePaise: paise.nullish(),
  minEarningPaise: paise.nullish(),
  orderFeePaise: paise.optional(),
  orderPercentBp: z.number().int().min(0).max(10000).optional(),
  peakBonusPaise: paise.optional(),
  isPeak: z.boolean().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  validFrom: date.nullish(),
  validTo: date.nullish(),
  isActive: z.boolean().optional(),
});

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
  return ok({ slots: await listSlots() });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
  return ok(await saveSlot(await parseBody(request, slotSchema), user), 201);
});
