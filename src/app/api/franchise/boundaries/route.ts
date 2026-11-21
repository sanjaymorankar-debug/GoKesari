/** Public: the zones as GeoJSON for the booking map (§5.5) — a drawn polygon, else a point at the centre of its areas, coloured by tier. */
import { NextResponse } from "next/server";

import { route } from "@/server/api/handler";
import { zonesGeoJson } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  return NextResponse.json(await zonesGeoJson(), { headers: { "content-type": "application/geo+json; charset=utf-8", "cache-control": "public, max-age=60" } });
});
