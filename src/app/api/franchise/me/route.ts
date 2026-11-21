/** The signed-in owner's franchise page (brief §10): only his own areas, shops and money. */
import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { ownerDashboard } from "@/server/franchise/dashboard";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  return ok(await ownerDashboard(user.id));
});
