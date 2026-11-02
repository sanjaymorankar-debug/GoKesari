/**
 * Admin → Shop referrals (shop-refers-shop, docs/dealer-programme/TIERED_COMMISSION.md Part B).
 *
 * GET ?status= → the referrals with their outcome. Admin and operator.
 * POST { action: "reverse", id, reason } → ADMIN only (checked in the service too): takes a reward back.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { SHOP_REFERRAL_STATUSES } from "@/lib/dealer-tiers";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { listShopReferrals, reverseShopReferral } from "@/server/services/shop-referrals";

export const dynamic = "force-dynamic";

const schema = z.object({ action: z.literal("reverse"), id: z.string().uuid(), reason: z.string().max(500) });

export const GET = route(async (request: NextRequest) => {
  await requireRole("ADMIN", "OPERATOR");
  const status = z.enum(SHOP_REFERRAL_STATUSES).safeParse(request.nextUrl.searchParams.get("status")).data;
  return ok({ referrals: await listShopReferrals({ status }) });
});

export const POST = route(async (request: NextRequest) => {
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, schema);
  return ok({ referral: await reverseShopReferral(body.id, body.reason, admin) });
});
