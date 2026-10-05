/**
 * Erase all seller-verification data for a closed shop — a seller's deletion
 * request (DPDP Act 2023). ADMIN only; refused while the shop still sells.
 * { shopId, reason }
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireRole } from "@/server/authz/guards";
import { eraseShopVerificationData } from "@/server/services/seller-verification";

const schema = z.object({ shopId: z.uuid(), reason: z.string().trim().min(3).max(500) });

export const POST = route(async (request: NextRequest) => {
  const user = await requireRole("ADMIN");
  enforceRateLimit(`seller-verification-erase:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await eraseShopVerificationData(body.shopId, body.reason, user));
});
