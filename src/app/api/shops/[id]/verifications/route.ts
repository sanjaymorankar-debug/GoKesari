/**
 * Seller document verification for one shop.
 *   GET  — all five documents (masked), what each shop needs, and the consistency score
 *   POST — { docType, number, consent: true } checks one document with the KYC vendor
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { SELLER_DOC_TYPES } from "@/lib/kyc/doc-formats";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getShopVerificationSummary, submitSellerDocument } from "@/server/services/seller-verification";

export const dynamic = "force-dynamic";

const schema = z.object({
  docType: z.enum(SELLER_DOC_TYPES),
  number: z.string().trim().min(1).max(80),
  consent: z.literal(true, { message: "Please agree to the verification consent." }),
});

function requestIp(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  return ok(await getShopVerificationSummary(id, user));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  enforceRateLimit(`seller-verification:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  const view = await submitSellerDocument({
    shopId: id,
    docType: body.docType,
    number: body.number,
    consentGiven: body.consent,
    actor: user,
    ipAddress: requestIp(request),
  });
  return ok(view);
});
