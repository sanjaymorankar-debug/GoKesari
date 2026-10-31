/**
 * Confirm it's you before changing or removing a verified bank account
 * (delivery partners, docs/gig-bank-payouts-2026-10):
 *   POST {}        → a code is emailed
 *   POST { code }  → the next change or removal within 10 minutes is allowed
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { confirmBankChangeCode, requestBankChangeCode } from "@/server/rider-wallet/withdrawals";

export const dynamic = "force-dynamic";

const schema = z.object({ code: z.string().trim().min(4).max(8).optional() });

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`rider-bank-reauth:${user.id}`, RATE_LIMITS.PAYMENT);
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  if (!body.code) return ok({ codeSent: await requestBankChangeCode(user, ip) });
  return ok(await confirmBankChangeCode(user, body.code, ip));
});
