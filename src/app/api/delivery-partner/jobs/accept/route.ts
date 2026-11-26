/**
 * Rider App v2 — take a job from Available Deliveries. Body { jobId }.
 * The first rider to accept gets it; a later accept answers 409 with
 * `error.details.reason = "OFFER_TAKEN"` ("Taken — another rider got it").
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { toRiderView } from "@/server/services/delivery-assignment";
import { acceptJob } from "@/server/services/rider-job-board";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ jobId: z.string().min(3).max(80) });

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  const { jobId } = await parseBody(request, bodySchema);
  return ok(toRiderView(await acceptJob(user.id, jobId)));
});
