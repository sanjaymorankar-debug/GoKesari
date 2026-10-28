/**
 * Add my shop: what the one-time registration fee comes to, before Submit.
 *
 * GET ?coupon=CODE[&turnover=RUPEES] → the base fee, the coupon's discount, GST
 * and the total. 422 (fields.couponCode) for a coupon that cannot be used. A
 * preview only: registerShop prices the fee again when the shop is saved.
 * Coupon codes are short, admin-chosen strings, so guessing is rate-limited.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { MAX_ANNUAL_TURNOVER_RUPEES } from "@/lib/registration-fee";
import { ok, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { quoteRegistrationFee } from "@/server/services/registration-fee-coupons";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  coupon: z.string().trim().max(40).optional(),
  turnover: z.coerce.number().int().min(0).max(MAX_ANNUAL_TURNOVER_RUPEES).optional(),
});

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
  if (query.coupon) enforceRateLimit(clientKey(request, `registration-fee-quote:${user.id}`), RATE_LIMITS.VOUCHER_PREVIEW);
  return ok(await quoteRegistrationFee({ ownerId: user.id, couponCode: query.coupon, turnoverRupees: query.turnover }));
});
