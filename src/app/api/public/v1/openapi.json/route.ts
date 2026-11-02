/** Public API (billing v2): its OpenAPI description — public, no token needed. */
import { NextResponse } from "next/server";

import { PUBLIC_OPENAPI } from "@/server/public-api/openapi";

export const dynamic = "force-static";

export function GET() {
  return NextResponse.json(PUBLIC_OPENAPI, { headers: { "cache-control": "public, max-age=3600" } });
}
