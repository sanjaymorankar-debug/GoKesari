/**
 * Who the shop-registration wizard's routes act for (onboarding WP7, docs/onboarding-waves-2-3-2026-11).
 *
 * Without the header: the signed-in user with SHOP_CREATE — exactly what every wizard route did before.
 * With `x-gk-assist-owner: <owner user id>`: a dealer, dealer employee or operator helping that owner,
 * allowed only while onboarding_assisted_mode_enabled is on, the helper holds a valid owner-consent
 * session and the owner's draft is the helper's (services/assisted-onboarding.ts). The wizard's
 * services then run for the owner, unchanged.
 */
import { z } from "zod";

import { requirePermission, requireUser, type AuthenticatedUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { actingOwnerFor } from "@/server/services/assisted-onboarding";

export const ASSIST_OWNER_HEADER = "x-gk-assist-owner";

export async function wizardActor(request?: Request): Promise<AuthenticatedUser> {
  const ownerId = request?.headers.get(ASSIST_OWNER_HEADER)?.trim();
  if (!request || !ownerId) return requirePermission(PERMISSIONS.SHOP_CREATE);
  const helper = await requireUser();
  const owner = z.string().uuid().parse(ownerId);
  return actingOwnerFor(helper, owner, { path: new URL(request.url).pathname, method: request.method });
}
