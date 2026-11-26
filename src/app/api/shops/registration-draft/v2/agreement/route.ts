/**
 * docs/onboarding-v2-2026-11 (Flow 2), step 6b and go-live:
 *   POST { action: "prepare" }  the shop row is created from the draft (PENDING) so the personalised agreement can
 *                               be shown and OTP-signed (/api/shops/<id>/agreements, the existing signer)
 *   POST { action: "accept", acceptSellerTerms?, acceptUndertaking }  the owner accepts; the shop goes live when
 *                               GST / PAN is verified and the fee is paid, else to the team's review.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { wizardActor } from "@/server/api/wizard-actor";
import { forbidden } from "@/lib/errors";
import { acceptV2Agreement, prepareV2Agreement } from "@/server/onboarding-v2/shop-flow";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prepare") }),
  z.object({ action: z.literal("accept"), acceptSellerTerms: z.boolean().optional(), acceptUndertaking: z.boolean().optional() }),
]);

export const POST = route(async (request: NextRequest) => {
  const user = await wizardActor(request);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const userAgent = request.headers.get("user-agent");
  if (body.action === "prepare") return ok(await prepareV2Agreement(user, { ip, userAgent }));
  // The owner accepts their own agreement; staff can only send them the link (seller-agreements rule).
  if (user.staff) throw forbidden("Only the shop's owner can accept the seller agreement.");
  return ok(await acceptV2Agreement(user, { acceptSellerTerms: body.acceptSellerTerms, acceptUndertaking: body.acceptUndertaking, ip, userAgent }));
});
