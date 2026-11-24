/**
 * docs/account-deletion-2026-11 — POST: checks nothing stands in the way, then
 * emails the confirmation code (OTP purpose ACCOUNT_DELETE) to the account's
 * own address. Limited like the email-change code: per network here, and per
 * account and per address in the OTP service. Flag off → 404.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requestAccountDeletionCode } from "@/server/services/account-deletion";
import { getRule } from "@/server/services/settings";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  const rules = await getRule("otp");
  enforceRateLimit(clientKey(request, "account-delete-code"), {
    limit: rules.maxRequestsPerIpPerWindow,
    windowMs: rules.resendWindowMinutes * 60_000,
  });
  enforceRateLimit(`account-delete-code-user:${user.id}`, {
    limit: rules.maxResendsPerWindow,
    windowMs: rules.resendWindowMinutes * 60_000,
  });
  return ok(
    await requestAccountDeletionCode(
      { id: user.id, role: user.role },
      { ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: request.headers.get("user-agent") },
    ),
  );
});
