/** docs/tax-register: every tax setting, its value in force and whether the CA approved it (Accountant, CA, admin). */
import { ok, route } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listTaxParameters } from "@/server/tax-register/changes";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireAnyPermission([PERMISSIONS.TAX_PARAM_PROPOSE, PERMISSIONS.TAX_PARAM_APPROVE]);
  return ok({ parameters: await listTaxParameters() });
});
