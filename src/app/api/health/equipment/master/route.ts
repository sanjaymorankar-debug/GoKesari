/** GET — the equipment master list (stores pick listings from it). */
import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { requireHealthEnabled } from "@/server/health/access";
import { equipmentMaster } from "@/server/health/rentals";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireUser();
  await requireHealthEnabled();
  return ok({ items: await equipmentMaster() });
});
