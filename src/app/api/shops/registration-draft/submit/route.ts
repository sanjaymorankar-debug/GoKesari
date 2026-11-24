/**
 * Onboarding wizard: POST "Create my shop and pay". The shop is created from
 * the owner's draft and its government checks are copied to the shop's seller
 * verifications; the answer is the wizard at its payment step (the payment
 * itself is POST /api/shops/[id]/registration-fee, as for Add my shop).
 * Body { acceptSellerTerms: true, acceptUndertaking: true } (both required, docs/seller-undertaking-2026-11).
 * Body { promiseDocuments: true } when a mandatory document is not verified
 * ("I will provide all relevant documents within 30 days").
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { wizardActor } from "@/server/api/wizard-actor";
import { submitDraftForPayment } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

// docs/seller-undertaking-2026-11: the two boxes ticked on the Payment step; the service refuses unless both are true.
const schema = z.object({ promiseDocuments: z.boolean().optional(), acceptSellerTerms: z.boolean().optional(), acceptUndertaking: z.boolean().optional() });

export const POST = route(async (request: NextRequest) => {
  const user = await wizardActor(request);
  // Only while the wizard flag is on (an admin may use it while it is off): the screen is not the only gate.
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const hasBody = Number(request.headers.get("content-length") ?? "0") > 0;
  const body = hasBody ? await parseBody(request, schema) : {};
  return ok(
    await submitDraftForPayment({
      actor: user,
      promiseDocuments: body.promiseDocuments === true,
      acceptSellerTerms: body.acceptSellerTerms === true,
      acceptUndertaking: body.acceptUndertaking === true,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      userAgent: request.headers.get("user-agent"),
    }),
  );
});
