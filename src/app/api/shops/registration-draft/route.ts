/**
 * Onboarding wizard (docs/shop-onboarding-wizard-2026-10): the signed-in
 * owner's registration in progress — masked numbers, check statuses, the
 * name and address filled from the GST record, the step to resume at and, once
 * the shop exists, its fee and status — or null.
 */
import { wizardActor } from "@/server/registration/wizard-actor";
import { ok, route } from "@/server/api/handler";
import { getWizardDraft } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

export const GET = route(async (request: Request) => {
  const user = await wizardActor(request);
  return ok(await getWizardDraft(user));
});
