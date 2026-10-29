/**
 * Onboarding wizard: POST "Create my shop and pay". The shop is created from
 * the owner's draft and its government checks are copied to the shop's seller
 * verifications; the answer is the wizard at its payment step (the payment
 * itself is POST /api/shops/[id]/registration-fee, as for Add my shop).
 * Body { promiseDocuments: true } when a mandatory document is not verified
 * ("I will provide all relevant documents within 30 days").
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requireWizardAvailable, submitDraftForPayment } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

const schema = z.object({ promiseDocuments: z.boolean().optional() });

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  // Only while the wizard flag is on (an admin may use it while it is off): the screen is not the only gate.
  await requireWizardAvailable(user);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const hasBody = Number(request.headers.get("content-length") ?? "0") > 0;
  const body = hasBody ? await parseBody(request, schema) : {};
  return ok(
    await submitDraftForPayment({
      actor: user,
      promiseDocuments: body.promiseDocuments === true,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    }),
  );
});
