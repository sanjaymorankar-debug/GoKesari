/**
 * Changing the account email needs a fresh code sent to the NEW address.
 * POST { email }        → sends the code
 * PUT  { email, code }  → checks it and saves the new email
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { confirmEmailChange, requestEmailChangeOtp } from "@/server/otp/service";
import { getRule } from "@/server/services/settings";

export const dynamic = "force-dynamic";

const requestSchema = z.object({ email: z.string().trim().max(254) });
const confirmSchema = z.object({ email: z.string().trim().max(254), code: z.string().trim().max(12) });

function ipOf(request: NextRequest): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  const rules = await getRule("otp");
  enforceRateLimit(clientKey(request, "email-change"), {
    limit: rules.maxRequestsPerIpPerWindow,
    windowMs: rules.resendWindowMinutes * 60_000,
  });
  const body = await parseBody(request, requestSchema);
  return ok(await requestEmailChangeOtp(user.id, { email: body.email, ip: ipOf(request) }));
});

export const PUT = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`email-change-verify:${user.id}`, { limit: 20, windowMs: 10 * 60_000 });
  const body = await parseBody(request, confirmSchema);
  return ok(await confirmEmailChange(user.id, user.role, { ...body, ip: ipOf(request) }));
});
