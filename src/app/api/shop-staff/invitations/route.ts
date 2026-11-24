/** Module 10: the signed-in person's open invitations to shops' staff. GET */
import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { listMyInvitations } from "@/server/services/shop-staff";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  return ok({ invitations: await listMyInvitations(user) });
});
