/**
 * Seller undertaking (docs/seller-undertaking-2026-11).
 *
 * GET  → { gateEnabled, accepted, required, version, termsVersion, effectiveDate, acceptedAt } for the
 *        signed-in shop owner. 401 for a guest, 403 for a user who owns no shop.
 * POST { acceptUndertaking: true, acceptTerms: true } → records both consents (one row per type per
 *        shop the owner owns) and answers the new status. Both must be the literal `true`: a missing,
 *        false or "true" value is refused with 422 — consent is an explicit act, never assumed.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { acceptSellerUndertaking, assertOwnsAShop, getSellerUndertakingStatus } from "@/server/services/seller-undertaking";

export const dynamic = "force-dynamic";

const schema = z.object({
  acceptUndertaking: z.literal(true, { message: "Tick the box to accept the seller undertaking." }),
  acceptTerms: z.literal(true, { message: "Tick the box to accept the Seller Terms, Terms & Conditions and Privacy Policy." }),
});

export const GET = route(async () => {
  const user = await requireUser();
  await assertOwnsAShop(user.id);
  return ok(await getSellerUndertakingStatus(user.id));
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`seller-undertaking:${user.id}`, RATE_LIMITS.MUTATION);
  await assertOwnsAShop(user.id);
  await parseBody(request, schema);
  await acceptSellerUndertaking({
    userId: user.id,
    actorRole: user.role,
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    userAgent: request.headers.get("user-agent"),
  });
  return ok(await getSellerUndertakingStatus(user.id));
});
