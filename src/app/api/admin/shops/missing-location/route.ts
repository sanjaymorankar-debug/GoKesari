/**
 * Shops left out of Nearby because they have no usable map location
 * (docs/nearby-referral-2026-10, feature 1). Operations and admin.
 *
 * GET                       → { shops, geocoding } — the report; ?format=csv for a spreadsheet
 * POST { shopIds?: [...] }  → fill locations from the shops' addresses (Google geocoding;
 *                             needs shop-update rights — operators and admin — and the server key)
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { isGeocodingConfigured } from "@/lib/env";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { shopsMissingLocation } from "@/server/services/nearby-shops";
import { backfillShopCoordinates } from "@/server/services/shop-location-backfill";

export const dynamic = "force-dynamic";

const csvCell = (v: unknown) => {
  const text = v == null ? "" : String(v);
  // Neutralise spreadsheet formulas, quote everything.
  return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
};

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.SHOP_APPROVE);
  const shops = await shopsMissingLocation();
  if (new URL(request.url).searchParams.get("format") === "csv") {
    const header = ["Registration no", "Shop", "Status", "Problem", "Owner", "Address", "Area", "City", "PIN", "Latitude", "Longitude", "Registered"];
    const lines = shops.map((s) =>
      [s.registrationNumber, s.name, s.status, s.problem, s.ownerName, s.addressLine1, s.area, s.city, s.pincode, s.latitude, s.longitude, s.createdAt.toISOString()]
        .map(csvCell)
        .join(","),
    );
    return new NextResponse([header.map(csvCell).join(","), ...lines].join("\r\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="shops-without-location.csv"`,
        "cache-control": "no-store",
      },
    });
  }
  return ok({ shops, geocoding: isGeocodingConfigured() });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_UPDATE_ANY);
  const body = await parseBody(request, z.object({ shopIds: z.array(z.string().uuid()).min(1).max(100).optional() }));
  const results = await backfillShopCoordinates({ apply: true, shopIds: body.shopIds, limit: 100 }, user);
  return ok({ results });
});
