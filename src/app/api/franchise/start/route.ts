/**
 * Onboarding v2 — Become a franchisee (docs/onboarding-v2-2026-11). Flag onboarding_v2.
 *   GET                       the account's state (live shop, dealer, roles, what the first payout still needs)
 *   POST { model: "free" }    free dealer: a request an admin approves and a second admin / operator confirms → GKD code
 *   POST { …, wantsSuper }    also ask to become a super dealer (owner 28-Nov-2026; approved by an admin / operator)
 *   POST { model: "paid" }    paid franchise: the dealer account from the shop; zones + plan + payment follow
 * Without a live shop: 409 with details.redirect = /shop/register?return=/franchise/start.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { forbidden } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { applyShopDetails } from "@/server/dealers/promotion";
import { requestSuperDealer } from "@/server/dealers/super-requests";
import { becomeFreeDealer, franchiseStartState, startPaidFranchise } from "@/server/onboarding-v2/franchise";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  const state = await franchiseStartState(user.id);
  if (!state.enabled) throw forbidden("Become a franchisee is not open yet.");
  return ok(state);
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`franchise-start:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, z.object({ model: z.enum(["free", "paid"]), wantsSuper: z.boolean().optional() }));
  const result = body.model === "free" ? await becomeFreeDealer(user) : await startPaidFranchise(user);
  // Owner, 28-Nov-2026: the shop's verified mobile, PAN, GSTIN and payout bank carry over (nothing typed or checked again).
  await applyShopDetails(result.dealerId, user);
  // Owner, 28-Nov-2026: "I also want to become a super dealer" — a request for an admin / operator, raised once he is a dealer.
  const superDealer = body.wantsSuper ? await requestSuperDealer(user) : null;
  return ok({ ...result, superDealer }, 201);
});
