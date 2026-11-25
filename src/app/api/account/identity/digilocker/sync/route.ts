/** docs/identity-verification-2026-11: the page asks where the DigiLocker session stands (polling fallback to the webhook). */
import { ok, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { syncMyIdentityDigilocker } from "@/server/services/identity-verification";

export const dynamic = "force-dynamic";

export const POST = route(async () => {
  const user = await requireUser();
  enforceRateLimit(`identity-digilocker-sync:${user.id}`, { limit: 60, windowMs: 10 * 60_000 });
  return ok({ verification: await syncMyIdentityDigilocker(user.id) });
});
