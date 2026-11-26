/**
 * docs/dual-auth-2026-11 — the two codes of a sensitive action (mobile / e-mail change, bank or payout account,
 * withdrawal, team role change, ownership transfer):
 *   { action: "start",  sensitive }                       → an SMS code + an e-mail code
 *   { action: "verify", sensitive, smsCode, emailCode }   → the action may be done for rule dualAuth.stepUpMinutes
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { SENSITIVE_ACTIONS, startDualStepUp, verifyDualStepUp } from "@/server/dual-auth/step-up";

export const dynamic = "force-dynamic";

const code = z.string().trim().regex(/^\d{4,8}$/, "Enter the 6-digit code.");
const sensitive = z.enum(SENSITIVE_ACTIONS);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), sensitive }),
  z.object({ action: z.literal("verify"), sensitive, smsCode: code, emailCode: code }),
]);

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`dual-step-up:${user.id}`, { limit: 20, windowMs: 15 * 60_000 });
  enforceRateLimit(clientKey(request, "dual-step-up"), { limit: 40, windowMs: 15 * 60_000 });
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  if (body.action === "start") return ok(await startDualStepUp(user.id, body.sensitive, ip));
  return ok(await verifyDualStepUp(user.id, body.sensitive, { smsCode: body.smsCode, emailCode: body.emailCode, ip }));
});
