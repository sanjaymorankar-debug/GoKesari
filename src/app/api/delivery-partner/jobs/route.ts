/**
 * Rider App v2 — Available Deliveries (rule riderJobBoard, off by default).
 * GET → { enabled, blockedReason, pollSeconds, jobs: RiderJob[] } for the signed-in rider.
 */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listOpenJobs } from "@/server/services/rider-job-board";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  return ok(await listOpenJobs(user.id));
});
