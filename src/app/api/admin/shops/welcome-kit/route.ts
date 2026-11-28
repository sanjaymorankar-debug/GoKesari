/**
 * docs/shop-welcome-kit-2026-11, requirement 7: Admin → Shops → Send welcome kit. Owner, 28-Nov-2026: one shop
 * (send, resend banner) for every role with shop-welcome-kit:send (Admin, Operator, Operations manager,
 * Support manager, Support user); bulk runs ADMIN only;
 * answers "not available" until the feature flag shop_welcome_kit_admin_send_enabled is on.
 *
 * GET  ?q=&city=&district=&notWelcomed=1   → { enabled, total, shops } (live shops + welcome-kit status)
 * POST { shopId }                          → send to one live shop (once per shop, ever)
 * POST { resendShopId }                    → 26-Nov-2026: "Resend updated banner" to one live shop
 * POST { bulk: { all: true } }             → 26-Nov-2026: every live shop that never had it (≤ 200 per run)
 * POST { bulk: { city?, districtCode? } }  → every live shop there that never had it (≤ 200 per run;
 *                                            sent by the outbox sweep). Tell the owner before a bulk
 *                                            run on gokesari.com.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { forbidden } from "@/lib/errors";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { findWelcomeKitShops, resendUpdatedBanner, sendWelcomeKitBulk, sendWelcomeKitToShop, welcomeKitAdminSendEnabled } from "@/server/shop-banner/admin-send";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.SHOP_WELCOME_KIT_SEND);
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
  z.object({ resendShopId: z.string().uuid() }).strict(),
  z.object({ bulk: z.object({ all: z.literal(true) }).strict() }).strict(),
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
  const user = await requirePermission(PERMISSIONS.SHOP_WELCOME_KIT_SEND);
  const input = await parseBody(request, body);
  if ("shopId" in input) return ok(await sendWelcomeKitToShop(input.shopId, user));
  if ("resendShopId" in input) return ok(await resendUpdatedBanner(input.resendShopId, user));
  // Bulk runs (a whole city, district or every shop) stay ADMIN only.
  if (user.role !== "ADMIN") throw forbidden("Only an admin can send the welcome kit to many shops at once.");
  return ok(await sendWelcomeKitBulk(input.bulk, user));
});
