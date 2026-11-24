/**
 * Customer barcode search (docs/search-brand-barcode-favourites-2026-11). Public, rate-limited.
 *   GET ?code=<EAN-8 | UPC-A | EAN-13 | GTIN-14>
 *     200 → { code, format, matches: BarcodeProductMatch[] }  (empty when no catalogue product has it;
 *           several when the code is shared — the customer picks)
 *     422 VALIDATION_FAILED → { reason: EMPTY | NOT_DIGITS | WRONG_LENGTH | CHECK_DIGIT } with a plain message
 *     404 while the flag brand_barcode_favourites_enabled is off (the route looks absent).
 * Nearby availability uses the customer's chosen delivery location when there is one.
 * The shop owner's lookup (/api/shops/[id]/barcode-lookup) is separate and unchanged.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, parseQuery, route } from "@/server/api/handler";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { getCurrentUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
import { requireFeature } from "@/server/services/feature-flags";
import { searchProductsByBarcode } from "@/server/services/product-barcode-search";
import { serviceableShopIds } from "@/server/services/serviceability";

export const dynamic = "force-dynamic";

const querySchema = z.object({ code: z.string().max(64).default("") });

export const GET = route(async (request: NextRequest) => {
  await requireFeature("brand_barcode_favourites_enabled");
  const user = await getCurrentUser();
  enforceRateLimit(user ? `barcode:${user.id}` : clientKey(request, "barcode"), RATE_LIMITS.BARCODE_LOOKUP);
  const { code } = parseQuery(request, querySchema);
  const location = await getCustomerLocation(user?.id).catch(() => null);
  const nearby = location ? await serviceableShopIds(location).catch(() => null) : null;
  const result = await searchProductsByBarcode(code, { nearbyShopIds: nearby ? [...nearby.keys()] : undefined });
  if (!result.ok) {
    throw validationFailed(result.message, { reason: result.reason, ...(result.expectedCheckDigit != null ? { expectedCheckDigit: result.expectedCheckDigit } : {}) });
  }
  const response = ok({ code: result.code, format: result.format, matches: result.matches });
  response.headers.set("Cache-Control", "private, max-age=60");
  return response;
});
