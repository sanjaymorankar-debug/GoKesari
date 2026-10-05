/** Admin review queue: seller documents waiting for a person to decide. */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listVerificationReviewQueue } from "@/server/services/seller-verification";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.SHOP_GST_PAN_VERIFY);
  return ok(await listVerificationReviewQueue(user));
});
