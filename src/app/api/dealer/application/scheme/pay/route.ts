/**
 * docs/dealer-platform phase 2: POST — open the gateway payment for the chosen scheme's joining charge. The charge
 * counts as paid only when the gateway's signed webhook confirms it (never on the browser's return).
 */
import { ok, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { startJoiningPayment } from "@/server/dealers/scheme-registration";
import { checkoutUrlOf } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const POST = route(async () => {
  await requireDealerProgramme();
  const user = await requireUser();
  enforceRateLimit(`dealer-joining-pay:${user.id}`, RATE_LIMITS.PAYMENT);
  const created = await startJoiningPayment(user);
  return ok({ intentId: created.intent.id, checkoutUrl: checkoutUrlOf(created as never), checkout: created.checkout ?? null });
});
