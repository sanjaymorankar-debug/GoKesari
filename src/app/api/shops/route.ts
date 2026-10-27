/** Public shop search (§15) and shop registration (§8). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { MAX_ANNUAL_TURNOVER_RUPEES } from "@/lib/registration-fee";
import { IDENTIFIER_REQUIRED_MESSAGE, parseGstin } from "@/lib/shop-identity";
import {
  deliveryFeePaiseSchema,
  freeDeliveryAbovePaiseSchema,
  openingHoursSchema,
  optionalText,
  requiredText,
  shopImageUrlSchema,
} from "@/lib/shop-settings";
import { SHOP_TYPE_KEYS, type ShopTypeKey } from "@/lib/shop-types";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getRule } from "@/server/services/settings";
import { registerShop, searchShops, toShopView } from "@/server/services/shops";
import { assertRegistrationReferralCode, attributeRegistrationReferral } from "@/server/services/referral-requests";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const p = new URL(request.url).searchParams;
  const type = p.get("type");
  // Search is public: the service returns only APPROVED shops, and only
  // their public card columns.
  return ok(
    await searchShops({
      query: p.get("q") ?? undefined,
      city: p.get("city") ?? undefined,
      area: p.get("area") ?? undefined,
      pincode: p.get("pincode") ?? undefined,
      shopType:
        type && (SHOP_TYPE_KEYS as readonly string[]).includes(type)
          ? (type as ShopTypeKey)
          : undefined,
      classification: (p.get("classification") as "KESARI" | "GREEN") ?? undefined,
      deliveryOnly: p.get("delivery") === "true",
      limit: Number(p.get("limit") ?? 24),
      offset: Number(p.get("offset") ?? 0),
    }),
  );
});

const registerSchema = z.object({
  // Text fields are trimmed before their length is checked, so "      " is not
  // an address and "   12 Padded Road   " is stored as "12 Padded Road" (TC-FLD-037).
  name: z.string().trim().min(1, "Shop name is required.").min(2).max(120),
  ownerName: z.string().trim().min(1, "Shop owner name is required.").min(2).max(120),
  phone: z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"),
  email: z.string().trim().email().nullish(),
  addressLine1: requiredText(3, 200),
  addressLine2: optionalText(200),
  area: optionalText(120),
  city: requiredText(2, 120),
  state: optionalText(120),
  pincode: z.string().trim().regex(/^\d{6}$/, "PIN code must be 6 digits"),
  latitude: z.string().nullish(),
  longitude: z.string().nullish(),
  pickupLatitude: z.string().nullish(),
  pickupLongitude: z.string().nullish(),
  pickupInstructions: optionalText(500),
  landmark: optionalText(200),
  shopType: z.enum(SHOP_TYPE_KEYS),
  /** Shop categories — at least one is required to register. */
  categoryIds: z
    .array(z.string().uuid())
    .min(1, "Please select at least one shop category.")
    .max(60),
  logoUrl: shopImageUrlSchema.nullish(),
  photos: z.array(shopImageUrlSchema).max(10).default([]),
  openingHours: openingHoursSchema.default([]),
  deliveryAvailable: z.boolean().default(false),
  deliveryFeePaise: deliveryFeePaiseSchema.default(0),
  freeDeliveryAbovePaise: freeDeliveryAbovePaiseSchema.nullish(),
  description: optionalText(1000),
  /**
   * Annual turnover in whole rupees; sets the one-time registration fee (rule
   * registrationFeeByTurnover). Required for a self-service registration while
   * the rule is on — checked in POST below, so a request cannot skip it to pay
   * the flat fee instead.
   */
  annualTurnoverRupees: z.number().int().min(0).max(MAX_ANNUAL_TURNOVER_RUPEES).nullish(),
  /** A registration-fee coupon; the server prices it (services/registration-fee-coupons.ts). */
  couponCode: z.string().trim().max(40).nullish(),

  /*
   * Business identifiers (GST included) — at least one is required (refinement below) so
   * every new registration can be checked for duplicates. Format checks and
   * normalisation live in the service (lib/shop-identity.ts), which reports
   * a bad value against its own field.
   */
  shopActNumber: z.string().max(60).nullish(),
  panNumber: z.string().max(20).nullish(),
  panHolderName: z.string().trim().max(120).nullish(),
  udyamNumber: z.string().max(40).nullish(),
  gstin: z.string().max(20).nullish(),

  /*
   * Operator-only fields (§4.1). They are accepted by the schema but only
   * *honoured* when the caller holds SHOP_REGISTRATION_MANAGE — see the
   * `privileged` flag below. A self-service applicant sending these gets them
   * silently ignored rather than a 403, so the happy path stays simple while
   * escalation stays impossible.
   */
  ownerId: z.string().uuid().optional(),
  registrationFeePaise: z.number().int().min(0).optional(),
  referralCode: z.string().max(32).nullish(),
  registrationDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date (YYYY-MM-DD).")
    .nullish(),

  // NOTE: status and classification are intentionally absent — they are
  // server-assigned and cannot be influenced by the applicant (§8, §10).
}).superRefine((body, ctx) => {
  if (
    !body.shopActNumber?.trim() &&
    !body.panNumber?.trim() &&
    !body.udyamNumber?.trim() &&
    !body.gstin?.trim()
  ) {
    ctx.addIssue({ code: "custom", path: ["identifiers"], message: IDENTIFIER_REQUIRED_MESSAGE });
  }
  if (body.gstin?.trim()) {
    const gst = parseGstin(body.gstin);
    if (!gst.ok) ctx.addIssue({ code: "custom", path: ["gstin"], message: gst.error });
  }
});

/**
 * 201 for a new registration; 200 when the caller's own rejected registration
 * of the same shop was updated and sent back for review (`resubmitted: true`).
 * 409 CONFLICT (details.reason "DUPLICATE_SHOP") when the shop is already
 * registered — see services/shop-duplicates.ts.
 */
export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  const body = await parseBody(request, registerSchema);

  const privileged = can(user.role, PERMISSIONS.SHOP_REGISTRATION_MANAGE);
  // Referral code (docs/four-features-2026-10): with rule shopReferral.required a
  // self-service registration needs a valid code — checked before anything is saved.
  if (!privileged && body.annualTurnoverRupees == null && (await getRule("registrationFeeByTurnover")).enabled) {
    throw validationFailed("Please check the highlighted fields.", {
      fields: { annualTurnover: "Enter your annual turnover — it sets the registration fee." },
    });
  }
  const referralCode = privileged ? null : await assertRegistrationReferralCode(body.referralCode);
  const result = await registerShop(body, user, { privileged });
  if (referralCode) await attributeRegistrationReferral(result, referralCode, user);
  return ok(toShopView(result), result.resubmitted ? 200 : 201);
});
