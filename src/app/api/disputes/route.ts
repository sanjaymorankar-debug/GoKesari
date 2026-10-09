/**
 * Dispute cases (GS-058). GET lists for operations; POST opens a case against
 * a delivered order — by the customer who owns it, or by staff on their behalf.
 * Opening returns the case number at once and notifies the shop and support.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { DISPUTE_LEVELS, DISPUTE_REASONS, DISPUTE_STATUSES } from "@/lib/dispute-states";
import { ok, parseBody, parseQuery, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission, requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listDisputes, openDispute } from "@/server/services/disputes";

const listSchema = z.object({
  status: z.enum(DISPUTE_STATUSES).optional(),
  level: z.enum(DISPUTE_LEVELS).optional(),
  shopId: z.string().uuid().optional(),
  liveOnly: z.coerce.boolean().optional(),
});

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.DISPUTE_MANAGE);
  const filters = parseQuery(request, listSchema);
  return ok(await listDisputes(filters));
});

const createSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.enum(DISPUTE_REASONS),
  description: z.string().min(10).max(2000),
  disputedAmountPaise: z.number().int().positive(),
  grievanceId: z.string().uuid().nullish(),
  /** Event layer: photos uploaded first through /api/images (purpose DISPUTE_EVIDENCE). */
  imageIds: z.array(z.string().uuid()).max(6).optional(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`dispute-open:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, createSchema);
  return ok(await openDispute(body, user), 201);
});
