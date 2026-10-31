/** Gig worker flow (feature 2): finish the Aadhaar check with the OTP the partner received. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { confirmMyAadhaarOtp } from "@/server/services/rider-kyc";

export const dynamic = "force-dynamic";

const schema = z.object({ otp: z.string().min(1).max(10) });

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  enforceRateLimit(`rider-kyc-aadhaar-verify:${user.id}`, { limit: 10, windowMs: 10 * 60_000 });
  const body = await parseBody(request, schema);
  return ok({ check: await confirmMyAadhaarOtp(user.id, body.otp) });
});
