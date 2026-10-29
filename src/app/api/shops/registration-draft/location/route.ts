/** Onboarding wizard step 2: POST { latitude, longitude, address? } — the map pin on the shop. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requireFeature } from "@/server/services/feature-flags";
import { saveDraftLocation } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

const schema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  address: z.string().trim().max(300).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  // The wizard exists only while its flag is on (404 otherwise), whatever the URL.
  await requireFeature("shop_onboarding_wizard_enabled");
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await saveDraftLocation({ actor: user, latitude: body.latitude, longitude: body.longitude, address: body.address }));
});
