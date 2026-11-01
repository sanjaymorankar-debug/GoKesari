/**
 * Withdraw unpaid earnings to the verified bank account (docs/gig-bank-payouts-2026-10):
 *   POST { amountPaise }        → a confirmation code is emailed
 *   POST { amountPaise, code }  → the withdrawal is made; returns the transfer
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requestWithdrawalCode, withdraw } from "@/server/rider-wallet/withdrawals";

export const dynamic = "force-dynamic";

const schema = z.object({
  amountPaise: z.number().int().positive().max(1_000_000_000),
  code: z.string().trim().min(4).max(8).optional(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`rider-withdrawal:${user.id}`, RATE_LIMITS.PAYMENT);
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  if (!body.code) return ok({ codeSent: await requestWithdrawalCode(user, body.amountPaise, ip) });
  return ok(await withdraw(user, { amountPaise: body.amountPaise, code: body.code }, ip), 201);
});
