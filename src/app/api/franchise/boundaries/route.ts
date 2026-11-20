/** Public: approved zone boundaries as GeoJSON with each zone's availability badge (the booking map). */
import { NextResponse } from "next/server";

import { route } from "@/server/api/handler";
import { boundariesGeoJson } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  return NextResponse.json(await boundariesGeoJson(), { headers: { "content-type": "application/geo+json; charset=utf-8", "cache-control": "public, max-age=60" } });
});
