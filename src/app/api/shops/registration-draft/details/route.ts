/**
 * Onboarding wizard step 2: POST the shop details — shop type, phone, turnover
 * (it sets the fee from the admin's slab table), and the name and address the GST
 * record pre-filled. Categories are optional here (chosen after approval). Validated like Add my shop; saved on the draft, nothing created yet.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { MAX_ANNUAL_TURNOVER_RUPEES } from "@/lib/registration-fee";
import { optionalText, requiredText } from "@/lib/shop-settings";
import { SHOP_TYPE_KEY_PATTERN } from "@/lib/shop-types";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requireWizardAvailable, saveDraftDetails } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

const nullable = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => v ?? null);

const schema = z.object({
  name: z.string().trim().min(2, "Shop name is required.").max(120),
  ownerName: z.string().trim().min(2, "Shop owner name is required.").max(120),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"),
  email: nullable(z.string().trim().email()),
  shopType: z.string().regex(SHOP_TYPE_KEY_PATTERN),
  // Chosen after approval on the wizard's category step (owner decision 29 Oct 2026); may come here too.
  categoryIds: z.array(z.string().uuid()).max(60).default([]),
  annualTurnoverRupees: nullable(z.number().int().min(0).max(MAX_ANNUAL_TURNOVER_RUPEES)),
  couponCode: nullable(z.string().trim().max(40)),
  referralCode: nullable(z.string().trim().max(32)),
  employeeId: nullable(z.string().trim().max(120)),
  addressLine1: requiredText(3, 200),
  addressLine2: nullable(optionalText(200)),
  area: nullable(optionalText(120)),
  city: requiredText(2, 120),
  state: nullable(optionalText(120)),
  pincode: z.string().trim().regex(/^[1-9]\d{5}$/, "PIN code must be 6 digits and not start with 0."),
  landmark: nullable(optionalText(200)),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  // Only while the wizard flag is on (an admin may use it while it is off): the screen is not the only gate.
  await requireWizardAvailable(user);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await saveDraftDetails({ actor: user, details: { ...body, email: body.email || null, couponCode: body.couponCode || null, referralCode: body.referralCode || null, employeeId: body.employeeId || null } }));
});
