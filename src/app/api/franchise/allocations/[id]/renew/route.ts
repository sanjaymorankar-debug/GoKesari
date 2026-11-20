/** POST — renew one area (open 30 days before expiry until 23:59:59 IST on the expiry day). Never auto-charged. */
import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { startRenewal } from "@/server/franchise/booking";
import { checkoutUrlOf } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: Request, { params }: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`franchise-renew:${user.id}`, RATE_LIMITS.PAYMENT);
  const created = await startRenewal((await params).id, user);
  return ok({ intentId: created.intent.id, checkoutUrl: checkoutUrlOf(created as never) });
});
