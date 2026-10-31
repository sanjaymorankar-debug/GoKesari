/** Delivery partner self-registration and admin queue (delivery-system Slice B). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { RIDER_GENDER_KEYS } from "@/lib/gig/registration";
import { VEHICLE_TYPE_KEYS } from "@/lib/vehicle-types";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { toStaffPartnerView } from "@/server/services/delivery-partner-kyc";
import {
  countDeliveryPartnersByStatus,
  listDeliveryPartners,
  registerDeliveryPartner,
} from "@/server/services/delivery-partners";

export const dynamic = "force-dynamic";

const registerSchema = z.object({
  fullName: z.string().min(2).max(120),
  mobile: z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"),
  email: z.string().email().nullish(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date (YYYY-MM-DD).")
    .nullish(),
  profilePhotoUrl: z.string().url().nullish(),
  panNumber: z.string().max(20).nullish(),
  governmentIdType: z.string().max(50).nullish(),
  governmentIdNumber: z.string().max(50).nullish(),
  bankAccountHolderName: z.string().max(120).nullish(),
  bankAccountNumber: z.string().max(30).nullish(),
  bankIfsc: z.string().max(15).nullish(),
  vehicleType: z.enum(VEHICLE_TYPE_KEYS),
  vehicleRegistrationNumber: z.string().max(30).nullish(),
  drivingLicenceNumber: z.string().max(30).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  operatingRadiusKm: z.number().int().positive().max(100).optional(),
  // Gig worker flow (feature 1): required by the service ({ required: true }), with field messages.
  gender: z.enum(RIDER_GENDER_KEYS).nullish(),
  addressLine: z.string().max(300).nullish(),
  addressCity: z.string().max(80).nullish(),
  addressPincode: z.string().max(10).nullish(),
  emergencyContactName: z.string().max(120).nullish(),
  emergencyContactMobile: z.string().max(15).nullish(),
  emergencyContactRelation: z.string().max(40).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_REGISTER);
  enforceRateLimit(`delivery-partner-register:${user.id}`, RATE_LIMITS.MUTATION);

  const body = await parseBody(request, registerSchema);
  // Gig worker flow: every detail of the brief, and the device location (feature 4), is required here.
  return ok(await registerDeliveryPartner(user.id, body, { required: true }), 201);
});

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.DELIVERY_PARTNER_MANAGE);
  const p = new URL(request.url).searchParams;

  if (p.get("dashboard") === "1") {
    return ok(await countDeliveryPartnersByStatus());
  }
  const partners = await listDeliveryPartners({
    status: (p.get("status") as never) ?? undefined,
  });
  return ok({ partners: partners.map(toStaffPartnerView) });
});
