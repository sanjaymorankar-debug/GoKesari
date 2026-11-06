/**
 * Barcode → product for this shop (onboarding Phase 2, WP2 — services/barcode-lookup.ts).
 *   GET ?code=8901234567890   { code, match | null } — its owner or staff
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireShopAccess } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { findProductByBarcode } from "@/server/services/barcode-lookup";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireShopAccess(id, { anyPermission: PERMISSIONS.SHOP_UPDATE_ANY });
  const result = await findProductByBarcode(id, request.nextUrl.searchParams.get("code") ?? "");
  if (!result) throw validationFailed("Enter the barcode number (at least 6 digits).");
  return ok(result);
});
