/** GET → the self-registration fee plans (Module 3). Admin. */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listTiers } from "@/server/registration/admin";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.REGISTRATION_FEE_MANAGE);
  return ok({ tiers: await listTiers() });
});
