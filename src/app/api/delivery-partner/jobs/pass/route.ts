/**
 * Rider App v2 — pass on a job in Available Deliveries with a reason.
 * Body { jobId, reason: TOO_FAR | VEHICLE_ISSUE | ENDING_SHIFT | OTHER, note? } → { passed: true }.
 * The job is not shown to this rider again.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { PASS_REASONS, passJob } from "@/server/services/rider-job-board";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  jobId: z.string().min(3).max(80),
  reason: z.enum(PASS_REASONS),
  note: z.string().max(300).optional(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  const body = await parseBody(request, bodySchema);
  await passJob(user.id, body.jobId, body.reason, body.note ?? null);
  return ok({ passed: true });
});
