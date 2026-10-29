/**
 * Onboarding wizard step 2: Udyam, FSSAI and Shop Act.
 *   POST { docType, number, consent: true } → checked with the government source
 *   POST { docType: "UDYAM" | "FSSAI" | "SHOP_ACT", has: false } → "I don't have one (now)";
 *     a mandatory one is then promised at "Create my shop and pay" (owner decision 29 Oct 2026)
 * POST so the number never lands in a URL or an access log.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requireFeature } from "@/server/services/feature-flags";
import { answerDraftDocument, submitDraftDocument } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

const schema = z.union([
  z.object({
    docType: z.enum(["UDYAM", "FSSAI", "SHOP_ACT"]),
    number: z.string().trim().min(1).max(60),
    consent: z.literal(true, { message: "Please agree to the verification consent." }),
  }),
  z.object({ docType: z.enum(["UDYAM", "FSSAI", "SHOP_ACT"]), has: z.literal(false) }),
]);

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  // The wizard exists only while its flag is on (404 otherwise), whatever the URL.
  await requireFeature("shop_onboarding_wizard_enabled");
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  if ("has" in body) return ok(await answerDraftDocument({ actor: user, docType: body.docType, has: false }));
  return ok(
    await submitDraftDocument({
      actor: user,
      docType: body.docType,
      number: body.number,
      consentGiven: body.consent,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    }),
  );
});
