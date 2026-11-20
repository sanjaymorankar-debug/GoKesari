/**
 * docs/shop-welcome-kit-2026-11, requirement 7: Admin → Shops → Send welcome kit. ADMIN only;
 * answers "not available" until the feature flag shop_welcome_kit_admin_send_enabled is on.
 *
 * GET  ?q=&city=&district=&notWelcomed=1   → { enabled, total, shops } (live shops + welcome-kit status)
 * POST { shopId }                          → send to one live shop (once per shop, ever)
 * POST { bulk: { city?, districtCode? } }  → every live shop there that never had it (≤ 200 per run;
 *                                            sent by the outbox sweep). Tell the owner before a bulk
 *                                            run on gokesari.com.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { findWelcomeKitShops, sendWelcomeKitBulk, sendWelcomeKitToShop, welcomeKitAdminSendEnabled } from "@/server/shop-banner/admin-send";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requireRole("ADMIN");
  const params = new URL(request.url).searchParams;
  const found = await findWelcomeKitShops({
    q: params.get("q"),
    city: params.get("city"),
    districtCode: params.get("district"),
    notWelcomedOnly: params.get("notWelcomed") === "1",
  });
  return ok({ enabled: await welcomeKitAdminSendEnabled(), ...found });
});

const body = z.union([
  z.object({ shopId: z.string().uuid() }).strict(),
  z
    .object({
      bulk: z
        .object({ city: z.string().trim().max(80).optional(), districtCode: z.string().trim().max(40).optional() })
        .strict()
        .refine((b) => Boolean(b.city || b.districtCode), "Choose a city or a district."),
    })
    .strict(),
]);

export const POST = route(async (request: NextRequest) => {
  const user = await requireRole("ADMIN");
  const input = await parseBody(request, body);
  if ("shopId" in input) return ok(await sendWelcomeKitToShop(input.shopId, user));
  return ok(await sendWelcomeKitBulk(input.bulk, user));
});
