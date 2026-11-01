/** Gig worker flow (feature 2): check the partner's PAN with the KYC provider, after consent. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { verifyMyPan } from "@/server/services/rider-kyc";

export const dynamic = "force-dynamic";

const schema = z.object({ pan: z.string().min(1).max(20), consent: z.boolean() });

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  // Each check is a billed vendor call.
  enforceRateLimit(`rider-kyc-pan:${user.id}`, { limit: 5, windowMs: 60 * 60_000 });
  const body = await parseBody(request, schema);
  const check = await verifyMyPan(user.id, {
    pan: body.pan,
    consentGiven: body.consent,
    ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
  });
  return ok({ check });
});
