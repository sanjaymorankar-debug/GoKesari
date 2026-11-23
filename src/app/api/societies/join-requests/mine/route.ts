/** docs/delta CF-006: the signed-in rider's own requests to join societies, newest first. */
import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { listMyJoinRequests } from "@/server/services/delta/society-join-requests";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  return ok(await listMyJoinRequests(user));
});
