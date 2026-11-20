/**
 * The equipment store's side (owner or GoKesari Health staff).
 * GET ?shopId= → profile, listings, rentals board, equipment master, the shop's products (to link "Buy").
 * POST ?shopId= { action: "profile", rentalTerms?, damagePolicy?, deliveryRadiusKm } | { action: "listing", …listingInput }
 */
import type { NextRequest } from "next/server";

import { notFound, validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireHealthEnabled } from "@/server/health/access";
import { bodyOf, str } from "@/server/health/http";
import { equipmentStoreForPage, saveEquipmentStoreProfile, saveListing, storeBoard } from "@/server/health/rentals";

export const dynamic = "force-dynamic";

async function store(request: NextRequest) {
  const user = await requireUser();
  await requireHealthEnabled();
  const s = await equipmentStoreForPage(user, request.nextUrl.searchParams.get("shopId"));
  if (!s) throw notFound("Store");
  return { user, shopId: s.shopId };
}

export const GET = route(async (request: NextRequest) => {
  const { user, shopId } = await store(request);
  return ok(await storeBoard(shopId, user));
});

export const POST = route(async (request: NextRequest) => {
  const { user, shopId } = await store(request);
  enforceRateLimit(`health-equipment-store:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await bodyOf(request);
  const action = str(body, "action");
  if (action === "profile") return ok({ profile: await saveEquipmentStoreProfile(shopId, body, user) });
  if (action === "listing") return ok({ listing: await saveListing(shopId, body, user) });
  throw validationFailed("Unknown action.");
});
