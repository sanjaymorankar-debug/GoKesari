/**
 * Admin: POST
 *   { action: "import", geojson }            bulk GeoJSON → one DRAFT per zone (nothing approved automatically)
 *   { action: "auto-reference", limit? }     reference points by geocoding the first locality ("auto – needs review")
 *   { action: "test-zone" }                  the hidden admin-only test zone T-QA1 (production end-to-end test)
 * GET → the boundaries GeoJSON including drafts (for the editor map).
 */
import { type NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireFranchiseAdmin, requireFranchiseReader } from "@/server/franchise/http";
import { autoSeedReferencePoints, boundariesGeoJson, ensureTestZone, importBoundariesGeoJson } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireFranchiseReader();
  return NextResponse.json(await boundariesGeoJson({ includeTest: true, includeDrafts: true }));
});

const body = z.discriminatedUnion("action", [z.object({ action: z.literal("import"), geojson: z.unknown() }), z.object({ action: z.literal("auto-reference"), limit: z.number().int().min(1).max(100).optional() }), z.object({ action: z.literal("test-zone") })]);

export const POST = route(async (request: NextRequest) => {
  const actor = await requireFranchiseAdmin();
  const b = await parseBody(request, body);
  if (b.action === "import") return ok(await importBoundariesGeoJson(b.geojson, actor));
  if (b.action === "auto-reference") return ok(await autoSeedReferencePoints(actor, { limit: b.limit }));
  return ok({ zoneId: await ensureTestZone(actor) });
});
