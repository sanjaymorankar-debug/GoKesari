/**
 * Onboarding wizard (docs/shop-onboarding-wizard-2026-10): the signed-in
 * owner's registration in progress — masked numbers, check statuses and the
 * name and address filled from the GST record — or null. The wizard resumes
 * from it.
 */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getOpenDraft } from "@/server/services/shop-registration-draft";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  return ok(await getOpenDraft(user));
});
