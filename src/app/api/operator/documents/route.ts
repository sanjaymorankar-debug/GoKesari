/** GET — documents waiting for a decision on the signed-in operator's own shops (F8.4.2). */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listDocumentsToVerify } from "@/server/services/operator-limited";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.OPERATOR_LIMITED_VERIFY_DOCS);
  return ok({ documents: await listDocumentsToVerify(user) });
});
