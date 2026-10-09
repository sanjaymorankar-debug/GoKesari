/**
 * POST → a payment order for the registration fee. The browser opens the
 * gateway's checkout; only the gateway's webhook approves the shop.
 */
import { NextResponse, type NextRequest } from "next/server";

import { route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { startRegistrationPayment } from "@/server/registration/service";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: { params: Promise<{ token: string }> }) => {
  enforceRateLimit(clientKey(request, "registration-pay"), { limit: 20, windowMs: 10 * 60_000 });
  const { token } = await context.params;
  return NextResponse.json(await startRegistrationPayment(token), { status: 201, headers: { "cache-control": "no-store" } });
});
