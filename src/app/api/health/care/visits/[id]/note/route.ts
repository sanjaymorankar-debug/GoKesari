/** GET — the visit note PDF (the patient side, or the practice that wrote it). Every look is in the access log. */
import type { NextRequest } from "next/server";

import { route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { careVisitNote } from "@/server/health/care";
import { fileResponse, ipOf, uuidParam } from "@/server/health/http";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const f = await careVisitNote(await uuidParam(context, "id"), user, ipOf(request));
  return fileResponse(f.data, f.contentType, f.fileName, request.nextUrl.searchParams.get("download") !== "1");
});
