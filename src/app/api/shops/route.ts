/** Public shop search (§15) and shop registration (§8). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { IDENTIFIER_REQUIRED_MESSAGE, parseGstin } from "@/lib/shop-identity";
import { SHOP_TYPE_KEYS, type ShopTypeKey } from "@/lib/shop-types";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { registerShop, searchShops, toShopView } from "@/server/services/shops";

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
  name: z.string().trim().min(1, "Shop name is required.").min(2).max(120),
  ownerName: z.string().trim().min(1, "Shop owner name is required.").min(2).max(120),
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
  pickupLatitude: z.string().nullish(),
  pickupLongitude: z.string().nullish(),
  pickupInstructions: z.string().max(500).nullish(),
  landmark: z.string().max(200).nullish(),
  shopType: z.enum(SHOP_TYPE_KEYS),
  /** Shop categories — at least one is required to register. */
  categoryIds: z
    .array(z.string().uuid())
    .min(1, "Please select at least one shop category.")
    .max(60),
  logoUrl: z.string().url().nullish(),
  photos: z.array(z.string().url()).max(10).default([]),
  openingHours: z
    .array(
      z.object({
        day: z.number().int().min(0).max(6),
        open: z.string(),
        close: z.string(),
        closed: z.boolean().optional(),
      }),
    )
    .default([]),
  deliveryAvailable: z.boolean().default(false),
  deliveryFeePaise: z.number().int().min(0).default(0),
  freeDeliveryAbovePaise: z.number().int().min(0).nullish(),
  description: z.string().max(1000).nullish(),

  /*
   * Business identifiers (GST included) — at least one is required (refinement below) so
   * every new registration can be checked for duplicates. Format checks and
   * normalisation live in the service (lib/shop-identity.ts), which reports
   * a bad value against its own field.
   */
  shopActNumber: z.string().max(60).nullish(),
  panNumber: z.string().max(20).nullish(),
  panHolderName: z.string().max(120).nullish(),
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
  const result = await registerShop(body, user, { privileged });
  return ok(toShopView(result), result.resubmitted ? 200 : 201);
});
