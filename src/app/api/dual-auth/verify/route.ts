/**
 * docs/dual-auth-2026-11 — DualVerify: verify the factor a signed-in account is missing.
 *   { action: "mobile-code",  mobile }         → an SMS code to the number
 *   { action: "mobile-verify", mobile, code }  → the number saved as verified (account check after the code)
 *   { action: "email-code",   email? }         → a code to the account's e-mail (or the address a mobile-only account adds)
 *   { action: "email-verify", email?, code }   → the e-mail verified
 * Answers the new status. Rate-limited per account and per IP on top of the per-number / per-e-mail code limits.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { confirmEmailFactorCode, confirmMobileFactorCode, dualVerifyStatus, sendEmailFactorCode, sendMobileFactorCode } from "@/server/dual-auth/verify";

export const dynamic = "force-dynamic";

const code = z.string().trim().regex(/^\d{4,8}$/, "Enter the 6-digit code.");
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mobile-code"), mobile: z.string().trim().min(10).max(16).optional() }),
  z.object({ action: z.literal("mobile-verify"), mobile: z.string().trim().min(10).max(16).optional(), code }),
  z.object({ action: z.literal("email-code"), email: z.string().trim().max(200).optional() }),
  z.object({ action: z.literal("email-verify"), email: z.string().trim().max(200).optional(), code }),
]);

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`dual-verify:${user.id}`, { limit: 30, windowMs: 15 * 60_000 });
  enforceRateLimit(clientKey(request, "dual-verify"), { limit: 60, windowMs: 15 * 60_000 });
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  switch (body.action) {
    case "mobile-code":
      return ok({ sent: await sendMobileFactorCode(user.id, body.mobile ?? null, ip), status: await dualVerifyStatus(user.id) });
    case "mobile-verify":
      await confirmMobileFactorCode(user.id, body.mobile ?? null, body.code, ip);
      return ok({ status: await dualVerifyStatus(user.id) });
    case "email-code":
      return ok({ sent: await sendEmailFactorCode(user.id, body.email ?? null, ip), status: await dualVerifyStatus(user.id) });
    case "email-verify":
      await confirmEmailFactorCode(user.id, body.email ?? null, body.code, ip);
      return ok({ status: await dualVerifyStatus(user.id) });
  }
});
