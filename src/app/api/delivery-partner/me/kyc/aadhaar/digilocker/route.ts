/**
 * Gig worker flow: "Verify with DigiLocker" — after consent, a DigiLocker link
 * for the partner's Aadhaar. `app`: the app build's URL scheme when the page
 * runs inside the GoKesari app, so DigiLocker's return hands back to the app.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { startMyAadhaarDigilocker } from "@/server/services/rider-kyc";

export const dynamic = "force-dynamic";

const schema = z.object({ consent: z.boolean(), app: z.string().max(40).nullish() });

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  enforceRateLimit(`rider-kyc-aadhaar-digilocker:${user.id}`, { limit: 10, windowMs: 60 * 60_000 });
  const body = await parseBody(request, schema);
  const started = await startMyAadhaarDigilocker(user.id, {
    consentGiven: body.consent,
    app: body.app ?? null,
    ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
  });
  return ok(started);
});
