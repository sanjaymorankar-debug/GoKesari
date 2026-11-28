/**
 * docs/onboarding-v2-2026-11 (Flow 2), step 6b and go-live:
 *   POST { action: "prepare" }  the shop row is created from the draft (PENDING) so the personalised agreement can
 *                               be shown and OTP-signed (/api/shops/<id>/agreements, the existing signer). v3 order
 *                               (0231): the shop is created and the agreement accepted at step 2 applied — live.
 *   POST { action: "accept", acceptSellerTerms?, acceptUndertaking }  the owner accepts; the shop goes live when
 *                               GST / PAN is verified and the fee is paid, else to the team's review.
 *   POST { action: "early", signerName, accepted[], acceptPolicies, acceptUndertaking, acceptLicencePromise }
 *                               v3 step 2: the seller agreement accepted before the shop exists (owner only).
 *   GET  ?doc=SELLER_SLA&lang=en  v3 step 2: the published template text (HTML, for the sandboxed viewer).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, parseQuery, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { wizardActor } from "@/server/api/wizard-actor";
import { forbidden } from "@/lib/errors";
import { AGREEMENT_LANGUAGES } from "@/server/db/schema";
import { agreementHtmlResponse } from "@/server/legal-agreements/http";
import { acceptV3EarlyAgreement, earlyAgreementHtml } from "@/server/onboarding-v2/early-agreement";
import { acceptV2Agreement, prepareV2Agreement } from "@/server/onboarding-v2/shop-flow";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DOC_TYPES = ["SELLER_SLA", "MEDICAL_ONBOARDING"] as const;

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prepare") }),
  z.object({ action: z.literal("accept"), acceptSellerTerms: z.boolean().optional(), acceptUndertaking: z.boolean().optional() }),
  z.object({
    action: z.literal("early"),
    signerName: z.string().trim().max(120),
    accepted: z.array(z.object({ docType: z.enum(DOC_TYPES), version: z.string().max(10) })).max(5),
    acceptPolicies: z.boolean(),
    acceptUndertaking: z.boolean(),
    acceptLicencePromise: z.boolean(),
  }),
]);

const textQuery = z.object({ doc: z.enum(DOC_TYPES), lang: z.enum(AGREEMENT_LANGUAGES).default("en") });

export const GET = route(async (request: NextRequest) => {
  await wizardActor(request);
  const q = parseQuery(request, textQuery);
  return agreementHtmlResponse((await earlyAgreementHtml(q.doc, q.lang)).html);
});

export const POST = route(async (request: NextRequest) => {
  const user = await wizardActor(request);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const userAgent = request.headers.get("user-agent");
  if (body.action === "prepare") return ok(await prepareV2Agreement(user, { ip, userAgent }));
  // The owner accepts their own agreement; staff can only send them the link (seller-agreements rule).
  if (user.staff) throw forbidden("Only the shop's owner can accept the seller agreement.");
  if (body.action === "early") {
    return ok(
      await acceptV3EarlyAgreement(user, {
        signerName: body.signerName,
        accepted: body.accepted,
        acceptPolicies: body.acceptPolicies,
        acceptUndertaking: body.acceptUndertaking,
        acceptLicencePromise: body.acceptLicencePromise,
        ip,
        userAgent,
      }),
    );
  }
  return ok(await acceptV2Agreement(user, { acceptSellerTerms: body.acceptSellerTerms, acceptUndertaking: body.acceptUndertaking, ip, userAgent }));
});
