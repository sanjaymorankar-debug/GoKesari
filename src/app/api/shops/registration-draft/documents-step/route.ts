/**
 * Shop registration (owner, 21-Nov-2026): POST — the optional documents screen between creating the
 * shop and paying is done ("Continue to payment" or "Upload later"). The uploads themselves go through
 * the shop's own document routes (/api/shops/{id}/documents/…).
 */
import { ok, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { finishDraftDocumentsStep } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

export const POST = route(async () => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  return ok(await finishDraftDocumentsStep({ actor: user }));
});
