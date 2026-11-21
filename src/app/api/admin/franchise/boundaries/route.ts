/**
 * Admin: POST
 *   { action: "import", geojson }   bulk GeoJSON → one DRAFT map shape per zone (map display only)
 *   { action: "test-zone" }         the hidden admin-only test zone T-QA1 (production end-to-end test)
 * GET → the zones GeoJSON (with the test zone) for the editor map.
 */
import { type NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireFranchiseAdmin, requireFranchiseReader } from "@/server/franchise/http";
import { ensureTestZone, importBoundariesGeoJson, zonesGeoJson } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireFranchiseReader();
  return NextResponse.json(await zonesGeoJson({ includeTest: true }));
});

const body = z.discriminatedUnion("action", [z.object({ action: z.literal("import"), geojson: z.unknown() }), z.object({ action: z.literal("test-zone") })]);

export const POST = route(async (request: NextRequest) => {
  const actor = await requireFranchiseAdmin();
  const b = await parseBody(request, body);
  if (b.action === "import") return ok(await importBoundariesGeoJson(b.geojson, actor));
  return ok({ zoneId: await ensureTestZone(actor) });
});
