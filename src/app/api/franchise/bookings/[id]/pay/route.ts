/**
 * POST — open the gateway payment for a reserved booking. The areas become ACTIVE only when the gateway's
 * signed webhook confirms the payment (never on the browser's return).
 */
import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { startBookingPayment } from "@/server/franchise/booking";
import { checkoutUrlOf } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: Request, { params }: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`franchise-pay:${user.id}`, RATE_LIMITS.PAYMENT);
  const created = await startBookingPayment((await params).id, user);
  return ok({ intentId: created.intent.id, checkoutUrl: checkoutUrlOf(created as never), checkout: created.checkout ?? null });
});
