/**
 * docs/fee-pay-later-2026-11 (0229; flag shop_fee_pay_later_enabled) — "Pay later" on the registration fee step:
 *   POST { slab, couponCode?, shopName, ownerName?, note? } → { view, amountPaise }
 * The fee is quoted as for a payment; the request goes to the administrators and the owner carries on registering.
 * Owner only: staff never ask on the owner's behalf.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { forbidden } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { wizardActor } from "@/server/api/wizard-actor";
import { requestDraftFeePayLater } from "@/server/onboarding-v2/shop-flow";

export const dynamic = "force-dynamic";

const schema = z.object({
  slab: z.number().int().min(1).max(50).nullish(),
  couponCode: z.string().trim().max(40).nullish(),
  shopName: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().max(100).nullish(),
  note: z.string().trim().max(500).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await wizardActor(request);
  if (user.staff) throw forbidden("Only the shop owner can ask to pay the registration fee later.");
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(
    await requestDraftFeePayLater(user, {
      slab: body.slab ?? null,
      couponCode: body.couponCode || null,
      shopName: body.shopName,
      ownerName: body.ownerName ?? null,
      note: body.note ?? null,
    }),
  );
});
