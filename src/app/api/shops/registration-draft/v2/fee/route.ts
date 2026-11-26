/**
 * docs/onboarding-v2-2026-11 (Flow 2), step 4 — the registration fee on the draft, straight after GST / PAN:
 *   POST { kind: "SHOP" | "WHOLESALE", shopName, ownerName? } → { redirectUrl, amountPaise, intentId, view }
 * Online only (the gateway's page, or the sandbox page on test.gokesari.com). The amount comes from rule
 * onboardingV2 (+ GST when feeGstExtra). Owner only: staff never start the owner's payment.
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
  kind: z.enum(["SHOP", "WHOLESALE"]),
  shopName: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().max(100).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await wizardActor(request);
  if (user.staff) throw forbidden("The owner pays the registration fee from their own account.");
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await startDraftFeeCheckout(user, { kind: body.kind, shopName: body.shopName, ownerName: body.ownerName ?? null }));
});
