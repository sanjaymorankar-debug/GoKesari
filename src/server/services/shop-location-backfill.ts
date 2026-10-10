/**
 * Filling in missing shop map locations from the shop's written address
 * (docs/nearby-referral-2026-10, feature 1): a shop without coordinates is
 * left out of Nearby, so operations can fill them here — one shop or all at
 * once from Admin → Shops without location, or by script
 * (scripts/backfill-shop-coordinates.ts).
 *
 * Google geocodes the address (GOOGLE_MAPS_SERVER_API_KEY, every call logged);
 * a result in another PIN code is refused. A filled location is marked
 * MANUAL_ENTRY and not verified — an address is less exact than a pin — so the
 * owner can still correct it with a pin under My shop → Location. Never
 * overwrites coordinates that are already valid.
 */
import { eq, inArray } from "drizzle-orm";

import { conflict, notFound } from "@/lib/errors";
import { isGeocodingConfigured } from "@/lib/env";
import { db } from "@/server/db";
import { shops, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { shopsMissingLocation } from "./nearby-shops";
import { geocodeShopAddress } from "./place-lookup";

export interface BackfillOutcome {
  shopId: string;
  name: string;
  result: "FILLED" | "NOT_FOUND" | "FAILED" | "WOULD_LOOK_UP";
  latitude?: number;
  longitude?: number;
  error?: string;
}

/** Looks up and (with apply) saves the location of shops missing one — all of them, or `shopIds`. */
export async function backfillShopCoordinates(
  options: { apply: boolean; shopIds?: string[]; limit?: number },
  actor: { id: string | null; role: UserRole | null },
): Promise<BackfillOutcome[]> {
  if (options.apply && !isGeocodingConfigured()) {
    throw conflict("Filling a location from the address needs Google geocoding (GOOGLE_MAPS_SERVER_API_KEY), which is not set on this server. Set the pin in the shop's Location page instead.");
  }
  let missing = await shopsMissingLocation();
  if (options.shopIds) {
    const wanted = new Set(options.shopIds);
    missing = missing.filter((s) => wanted.has(s.id));
    if (missing.length === 0) throw notFound("A shop without a location");
  }
  missing = missing.slice(0, Math.min(options.limit ?? 100, 500));
  if (missing.length === 0) return [];
  const rows = await db.select().from(shops).where(inArray(shops.id, missing.map((m) => m.id)));

  const out: BackfillOutcome[] = [];
  for (const shop of rows) {
    if (!options.apply) {
      out.push({ shopId: shop.id, name: shop.name, result: "WOULD_LOOK_UP" });
      continue;
    }
    try {
      const found = await geocodeShopAddress(shop, shop.id);
      if (!found) {
        out.push({ shopId: shop.id, name: shop.name, result: "NOT_FOUND" });
        continue;
      }
      const latitude = found.latitude.toFixed(6);
      const longitude = found.longitude.toFixed(6);
      await db
        .update(shops)
        .set({ latitude, longitude, locationVerified: false, locationVerifiedAt: null, locationSource: "MANUAL_ENTRY", updatedAt: new Date() })
        .where(eq(shops.id, shop.id));
      await recordAudit({
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_UPDATED,
        entityType: "shop",
        entityId: shop.id,
        previousValue: { latitude: shop.latitude, longitude: shop.longitude },
        newValue: { latitude, longitude, locationSource: "MANUAL_ENTRY", from: "address (backfill)" },
      });
      out.push({ shopId: shop.id, name: shop.name, result: "FILLED", latitude: Number(latitude), longitude: Number(longitude) });
    } catch (error) {
      out.push({ shopId: shop.id, name: shop.name, result: "FAILED", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}
