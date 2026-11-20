/** Opens a patient's share link (no sign-in; expires; every open is in the patient's access log). */
import type { NextRequest } from "next/server";

import { route, type RouteContext } from "@/server/api/handler";
import { fileResponse, ipOf } from "@/server/health/http";
import { openShareLink } from "@/server/health/records";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ token: string }>) => {
  const f = await openShareLink((await context.params).token, ipOf(request));
  return fileResponse(f.data, f.contentType, f.fileName);
});
