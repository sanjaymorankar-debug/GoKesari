/**
 * POST → ask Cashfree (server to server) whether the latest registration-fee
 * payment was paid, and approve the shop when it was — the same checks as the
 * webhook (docs/payments-cashfree-audit-2026-11). The applicant's page calls it
 * once the checkout closes, so a lost webhook never leaves a paid shop waiting.
 * Nothing the browser sends is trusted: only the token picks the registration.
 */
import { NextResponse, type NextRequest } from "next/server";

import { route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { checkRegistrationPayment } from "@/server/registration/service";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: { params: Promise<{ token: string }> }) => {
  enforceRateLimit(clientKey(request, "registration-check-payment"), { limit: 20, windowMs: 10 * 60_000 });
  const { token } = await context.params;
  return NextResponse.json(await checkRegistrationPayment(token), { headers: { "cache-control": "no-store" } });
});
