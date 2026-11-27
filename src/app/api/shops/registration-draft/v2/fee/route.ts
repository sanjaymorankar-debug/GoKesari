/**
 * docs/onboarding-v2-2026-11 (Flow 2), step 4 — the registration fee on the draft, straight after GST / PAN:
 *   POST { slab, couponCode?, shopName, ownerName? } → { redirectUrl, amountPaise, intentId, view }
 * Online only (the gateway's page, or the sandbox page on test.gokesari.com). Owner, 27-Nov-2026: the original fee —
 * the turnover band's slab (rule registrationFeeByTurnover; slab null when that rule is off: the flat fee), less an
 * optional registration-fee coupon, + GST. Owner only: staff never start the owner's payment.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { forbidden } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { wizardActor } from "@/server/api/wizard-actor";
import { startDraftFeeCheckout } from "@/server/onboarding-v2/shop-flow";

export const dynamic = "force-dynamic";

const schema = z.object({
  slab: z.number().int().min(1).max(50).nullish(),
  couponCode: z.string().trim().max(40).nullish(),
  shopName: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().max(100).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await wizardActor(request);
  if (user.staff) throw forbidden("The owner pays the registration fee from their own account.");
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await startDraftFeeCheckout(user, { slab: body.slab ?? null, couponCode: body.couponCode || null, shopName: body.shopName, ownerName: body.ownerName ?? null }));
});
