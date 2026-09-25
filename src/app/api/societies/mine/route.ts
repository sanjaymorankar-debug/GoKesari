/** The signed-in user's society memberships (any status except removed). */
import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { listMySocieties } from "@/server/services/societies";

export const GET = route(async () => {
  const user = await requireUser();
  return ok(await listMySocieties(user.id));
});
