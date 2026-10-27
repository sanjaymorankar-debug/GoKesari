/**
 * Manual fallback for the dispute SLA check (no scheduler runs it any more):
 * administrators can run the same escalation as the queue load does.
 */
import { ok, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { runDisputeEscalationSweep } from "@/server/services/disputes";

export const POST = route(async () => {
  await requireRole("ADMIN");
  return ok(await runDisputeEscalationSweep());
});
