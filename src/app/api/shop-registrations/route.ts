/**
 * POST { shopName, mobile, referralCode, tierCode, otp, acceptTerms } →
 * 201 { token } — the registration is saved as PENDING_PAYMENT; the token is
 * the applicant's private link (/shop/join/{token}), also sent by SMS.
 */
import { NextResponse, type NextRequest } from "next/server";

import { parseBody, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { createRegistration, createRegistrationSchema } from "@/server/registration/service";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "registration-create"), { limit: 10, windowMs: 60 * 60_000 });
  const input = await parseBody(request, createRegistrationSchema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const { token, registration } = await createRegistration(input, ip);
  return NextResponse.json({ token, status: registration.status, feePaise: registration.feePaise }, { status: 201, headers: { "cache-control": "no-store" } });
});
