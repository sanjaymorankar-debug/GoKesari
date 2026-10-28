/** GET — the shops attributed to the signed-in dealer (theirs only). docs/dealer-programme. */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listDealerShops } from "@/server/dealers/disputes";
import { requireDealerProgramme } from "@/server/dealers/http";
import { requireApprovedDealer } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireDealerProgramme();
  const user = await requirePermission(PERMISSIONS.DEALER_PORTAL);
  return ok({ shops: await listDealerShops((await requireApprovedDealer(user)).id) });
});
