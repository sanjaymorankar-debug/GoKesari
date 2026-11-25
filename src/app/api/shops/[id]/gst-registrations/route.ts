/**
 * Many GSTINs per shop (owner, 25-Nov-2026): GET the main GSTIN and the extra ones (owner, or
 * staff who may verify GST/PAN); POST { gstin, consent: true } adds one (owner only, shop live),
 * checked with the KYC vendor at once. POST so the number never lands in a URL or an access log.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { addShopGstRegistration, listShopGstRegistrations } from "@/server/services/shop-gst-registrations";

export const dynamic = "force-dynamic";

const schema = z.object({
  gstin: z.string().trim().min(1).max(20),
  consent: z.literal(true, { message: "Please agree to the verification consent." }),
});

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  return ok(await listShopGstRegistrations(id));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_GST_PAN_VERIFY });
  enforceRateLimit(`shop-gst-registrations:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await addShopGstRegistration({ shopId: id, gstin: body.gstin, consentGiven: body.consent, actor: user }));
});
