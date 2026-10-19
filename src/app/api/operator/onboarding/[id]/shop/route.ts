/**
 * POST — registers the shop for the owner who confirmed the code (F8.4.2), with
 * the referral code. The same fields and checks as a self-service registration;
 * never the fee, the registration date or the owner (those come from the
 * onboarding). 201 with the shop.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { IDENTIFIER_REQUIRED_MESSAGE, parseGstin } from "@/lib/shop-identity";
import { SHOP_TYPE_KEYS } from "@/lib/shop-types";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { submitOnboardedShop } from "@/server/services/operator-limited";
import { toShopView } from "@/server/services/shops";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    name: z.string().trim().min(2).max(120),
    ownerName: z.string().trim().min(2).max(120),
    phone: z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"),
    email: z.string().email().nullish(),
    addressLine1: z.string().min(3).max(200),
    addressLine2: z.string().max(200).nullish(),
    area: z.string().max(120).nullish(),
    city: z.string().min(2).max(120),
    state: z.string().max(120).nullish(),
    pincode: z.string().regex(/^\d{6}$/, "PIN code must be 6 digits"),
    latitude: z.string().nullish(),
    longitude: z.string().nullish(),
    landmark: z.string().max(200).nullish(),
    shopType: z.enum(SHOP_TYPE_KEYS),
    categoryIds: z.array(z.string().uuid()).min(1, "Please select at least one shop category.").max(60),
    deliveryAvailable: z.boolean().default(false),
    description: z.string().max(1000).nullish(),
    shopActNumber: z.string().max(60).nullish(),
    panNumber: z.string().max(20).nullish(),
    panHolderName: z.string().max(120).nullish(),
    udyamNumber: z.string().max(40).nullish(),
    gstin: z.string().max(20).nullish(),
    referralCode: z.string().trim().max(32).nullish(),
  })
  .superRefine((body, ctx) => {
    if (!body.shopActNumber?.trim() && !body.panNumber?.trim() && !body.udyamNumber?.trim() && !body.gstin?.trim()) {
      ctx.addIssue({ code: "custom", path: ["identifiers"], message: IDENTIFIER_REQUIRED_MESSAGE });
    }
    if (body.gstin?.trim()) {
      const gst = parseGstin(body.gstin);
      if (!gst.ok) ctx.addIssue({ code: "custom", path: ["gstin"], message: gst.error });
    }
  });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.OPERATOR_LIMITED_ONBOARD);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  const result = await submitOnboardedShop(z.string().uuid().parse(id), body, user);
  return ok({ sessionId: result.sessionId, shop: toShopView(result.shop) }, 201);
});
