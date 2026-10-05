/** The signed-in user's own delivery-partner application/profile. PATCH: self-edit of everyday fields (F2). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { VEHICLE_TYPE_KEYS } from "@/lib/vehicle-types";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { updateMyRiderProfile } from "@/server/services/rider-profile";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  return ok(await getMyDeliveryPartnerProfile(user.id));
});

const patchSchema = z
  .object({
    fullName: z.string().max(120),
    mobile: z.string().max(20),
    email: z.string().max(200).nullable(),
    dateOfBirth: z.string().max(10).nullable(),
    profilePhotoUrl: z.string().max(500).nullable(),
    vehicleType: z.enum(VEHICLE_TYPE_KEYS),
    vehicleRegistrationNumber: z.string().max(30).nullable(),
    operatingRadiusKm: z.number().int(),
  })
  .partial()
  .strict();

export const PATCH = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  enforceRateLimit(`rider-profile:${user.id}`, RATE_LIMITS.MUTATION);
  return ok(await updateMyRiderProfile(user.id, await parseBody(request, patchSchema)));
});
