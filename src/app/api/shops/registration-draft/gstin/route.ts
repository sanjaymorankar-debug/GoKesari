/**
 * Onboarding wizard step 1: POST { gstin, consent: true } checks the GSTIN with
 * the government source, then the PAN inside it, and fills the shop's name and
 * address from the GST record. POST so the number never lands in a URL or an
 * access log.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { submitDraftGstin } from "@/server/services/shop-registration-draft";

export const dynamic = "force-dynamic";

const schema = z.object({
  gstin: z.string().trim().min(1).max(20),
  consent: z.literal(true, { message: "Please agree to the verification consent." }),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(
    await submitDraftGstin({
      gstin: body.gstin,
      consentGiven: body.consent,
      actor: user,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    }),
  );
});
