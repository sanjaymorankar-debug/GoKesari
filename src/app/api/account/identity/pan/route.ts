/**
 * docs/identity-verification-2026-11: verify with PAN instead of Aadhaar
 * (always offered unless rule identityVerification.allowedMethods is
 * "aadhaar_only"). Only the last four characters are kept. 404 while the flag is off.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { verifyIdentityWithPan } from "@/server/services/identity-verification";

export const dynamic = "force-dynamic";

const schema = z.object({ consent: z.boolean(), pan: z.string().max(20) });

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`identity-pan:${user.id}`, { limit: 5, windowMs: 60 * 60_000 });
  const body = await parseBody(request, schema);
  return ok({
    verification: await verifyIdentityWithPan(user.id, {
      pan: body.pan,
      consentGiven: body.consent,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      userAgent: request.headers.get("user-agent"),
    }),
  });
});
