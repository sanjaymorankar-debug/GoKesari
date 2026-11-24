/**
 * docs/hdms-2026-11: a shop's own rider — on duty or not, vehicle, ID proof (only the last 4 characters
 * of the number are kept; the shop's own riders only: another shop's rider is "not found").
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { updateShopRiderProfile } from "@/server/delivery/admin";

const schema = z.object({
  isAvailable: z.boolean().optional(),
  vehicleType: z.enum(["BICYCLE", "SCOOTER", "MOTORCYCLE", "E_BIKE", "THREE_WHEELER", "ON_FOOT"]).nullable().optional(),
  idDocumentType: z.enum(["AADHAAR", "PAN", "DRIVING_LICENCE", "VOTER_ID"]).nullable().optional(),
  idDocumentNumber: z.string().trim().min(4).max(30).nullable().optional(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string; staffId: string }>) => {
  const { id, staffId } = await context.params;
  const { user } = await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY });
  enforceRateLimit(`delivery-staff:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  const row = await updateShopRiderProfile(id, staffId, body);
  return ok({ id: row.id, isAvailable: row.isAvailable, vehicleType: row.vehicleType, idDocumentType: row.idDocumentType, idDocumentLast4: row.idDocumentLast4, kycStatus: row.kycStatus });
});
