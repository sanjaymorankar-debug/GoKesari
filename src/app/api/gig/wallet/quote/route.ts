/**
 * What a withdrawal would pay, before the rider confirms (docs/gig-bank-payouts-2026-10):
 *   GET ?amountPaise=… → { amountPaise, feePaise, tdsPaise, netPaise, settlement, account, problem }
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { quoteWithdrawal } from "@/server/rider-wallet/views";
import { requireFeature } from "@/server/services/feature-flags";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  await requireFeature("rider_withdrawal_enabled");
  const amount = Number(request.nextUrl.searchParams.get("amountPaise") ?? "0");
  return ok(await quoteWithdrawal(user.id, Number.isFinite(amount) ? Math.round(amount) : 0));
});
