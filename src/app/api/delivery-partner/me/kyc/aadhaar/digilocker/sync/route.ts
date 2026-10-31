/** Gig worker flow: the KYC page asks where the partner's DigiLocker session stands (polling fallback to the webhook). */
import { ok, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { syncMyAadhaarDigilocker } from "@/server/services/rider-kyc";

export const dynamic = "force-dynamic";

export const POST = route(async () => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  enforceRateLimit(`rider-kyc-aadhaar-digilocker-sync:${user.id}`, { limit: 60, windowMs: 10 * 60_000 });
  return ok({ check: await syncMyAadhaarDigilocker(user.id) });
});
