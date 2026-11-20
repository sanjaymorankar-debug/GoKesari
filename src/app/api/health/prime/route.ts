/**
 * GoKesari Health Prime, the shop's side (owner; Health staff may look).
 * GET ?shopId — tier, plans (prices as this shop pays them), subscriptions and invoices, virtual number,
 *               call log, analytics for 7 / 30 / 90 days.
 * POST { action: "quote" | "buy", shopId, planId, term, couponCode? } — buy returns where to pay.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireHealthEnabled } from "@/server/health/access";
import { bodyOf } from "@/server/health/http";
import { primeShopView, quotePrime, requirePrimeAccess, startPrimePurchase } from "@/server/health/prime";

export const dynamic = "force-dynamic";

const shopIdOf = (v: unknown) => z.string().uuid().parse(v);

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  await requireHealthEnabled();
  return ok(await primeShopView(shopIdOf(request.nextUrl.searchParams.get("shopId")), user));
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`health-prime:${user.id}`, RATE_LIMITS.PAYMENT);
  await requireHealthEnabled();
  const body = await bodyOf(request);
  const shopId = shopIdOf(body.shopId);
  switch (body.action) {
    case "quote":
      await requirePrimeAccess(shopId, user);
      return ok({ quote: await quotePrime(shopId, body) });
    case "buy": {
      const r = await startPrimePurchase(shopId, body, user);
      return ok({ subscriptionId: r.subscription.id, status: r.subscription.status, checkoutUrl: r.checkoutUrl, quote: r.quote }, 201);
    }
    default:
      throw validationFailed("Unknown action.");
  }
});
