/**
 * docs/onboarding-v2-2026-11, step 5: the delivery location for orders placed before it was known (a saved address,
 * or GPS + map pin), plus the optional name, "save this address" and referral code. Only the customer who placed
 * the orders, only while they wait for it. Not gated by the flag: an order waiting for its address must still be
 * able to get one if the flag is switched off meanwhile (no other order ever waits).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { setDeliveryLocationAfterPayment } from "@/server/onboarding-v2/customer";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    orderIds: z.array(z.string().uuid()).min(1).max(20),
    addressId: z.string().uuid().nullish(),
    address: z
      .object({
        line1: z.string().trim().min(1).max(200),
        area: z.string().trim().max(120).nullish(),
        city: z.string().trim().min(1).max(80),
        state: z.string().trim().max(80).nullish(),
        pincode: z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit PIN code."),
        landmark: z.string().trim().max(120).nullish(),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
      .nullish(),
    saveAddress: z.boolean().optional(),
    name: z.string().trim().max(80).nullish(),
    referralCode: z.string().trim().max(32).nullish(),
  })
  .refine((b) => Boolean(b.addressId) !== Boolean(b.address), { message: "Choose a saved address or set the location on the map." });

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`ov2-delivery-location:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await setDeliveryLocationAfterPayment({ id: user.id, role: user.role }, body));
});
