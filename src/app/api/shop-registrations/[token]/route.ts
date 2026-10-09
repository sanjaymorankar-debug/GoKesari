/** GET → the registration's status for the applicant's page (the token is the access). */
import { NextResponse, type NextRequest } from "next/server";

import { route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { registrationStatus } from "@/server/registration/service";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: { params: Promise<{ token: string }> }) => {
  enforceRateLimit(clientKey(request, "registration-status"), { limit: 120, windowMs: 10 * 60_000 });
  const { token } = await context.params;
  return NextResponse.json(await registrationStatus(token), { headers: { "cache-control": "no-store" } });
});
