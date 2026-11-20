/**
 * The medical store's GoKesari Health profile (src/server/health/rx-orders.ts): drug licence, registered
 * pharmacist, delivery options. Owner of the PHARMACY shop (staff may read).
 * GET ?shopId=<id>  → { shop, profile | null }   (no shopId: the user's medical stores)
 * POST { shopId, drugLicenceNumber, pharmacistName, pharmacistRegistrationNumber, pharmacyCouncil?,
 *        acceptsPrescriptions, ownDelivery, cashOnHandover, deliveryRadiusKm } → saved (verification PENDING on a licence change)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { pharmacyProfileOf, pharmacyShopsOf, savePharmacyProfile } from "@/server/health/rx-orders";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const shopId = request.nextUrl.searchParams.get("shopId");
  if (!shopId) return ok({ stores: await pharmacyShopsOf(user.id) });
  return ok(await pharmacyProfileOf(z.string().uuid().parse(shopId), user));
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`health-pharmacy:${user.id}`, RATE_LIMITS.MUTATION);
  const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const shopId = z.string().uuid({ message: "Choose the store." }).parse(body.shopId);
  return ok({ profile: await savePharmacyProfile(shopId, body, user) });
});
