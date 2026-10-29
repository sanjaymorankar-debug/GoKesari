/**
 * Onboarding wizard (docs/shop-onboarding-wizard-2026-10): the signed-in
 * owner's registration in progress — masked numbers, check statuses, the
 * name and address filled from the GST record, the step to resume at and, once
 * the shop exists, its fee and status — or null.
 */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getWizardDraft } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  return ok(await getWizardDraft(user));
});
