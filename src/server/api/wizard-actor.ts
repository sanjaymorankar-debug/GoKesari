/**
 * Who the shop-registration wizard's routes act for (onboarding WP7, docs/onboarding-waves-2-3-2026-11).
 *
 * Without the header: the signed-in user with SHOP_CREATE — exactly what every wizard route did before.
 * With `x-gk-assist-owner: <owner user id>`: a dealer, dealer employee or operator helping that owner,
 * allowed only while onboarding_assisted_mode_enabled is on, the helper holds a valid owner-consent
 * session and the owner's draft is the helper's (services/assisted-onboarding.ts). The wizard's
 * services then run for the owner, unchanged.
 *
 * With `x-gk-registration-draft: <draft id>` (owner, 25-Nov-2026): an admin or operations user with
 * SHOP_REGISTRATION_MANAGE continuing that owner's unfinished registration (Admin → Unfinished
 * registrations); audit entries name the staff member (server/registration/wizard-actor.ts).
 */
import { z } from "zod";

import { requirePermission, requireUser, type AuthenticatedUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { STAFF_DRAFT_HEADER, staffActorForDraft } from "@/server/registration/wizard-actor";
import { actingOwnerFor } from "@/server/services/assisted-onboarding";
import type { Actor } from "@/server/services/shop-registration-draft";

export const ASSIST_OWNER_HEADER = "x-gk-assist-owner";

export async function wizardActor(request?: Request): Promise<AuthenticatedUser & Pick<Actor, "staff">> {
  const draftId = request?.headers.get(STAFF_DRAFT_HEADER)?.trim();
  if (draftId) {
    const staff = await requirePermission(PERMISSIONS.SHOP_REGISTRATION_MANAGE);
    return staffActorForDraft(draftId, { id: staff.id, role: staff.role });
  }
  const ownerId = request?.headers.get(ASSIST_OWNER_HEADER)?.trim();
  if (!request || !ownerId) return requirePermission(PERMISSIONS.SHOP_CREATE);
  const helper = await requireUser();
  const owner = z.string().uuid().parse(ownerId);
  return actingOwnerFor(helper, owner, { path: new URL(request.url).pathname, method: request.method });
}
