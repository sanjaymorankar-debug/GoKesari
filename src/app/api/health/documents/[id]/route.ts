/** A document in my record: GET → the file (logged); DELETE → remove one I uploaded. */
import type { NextRequest } from "next/server";

import { noContent, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { fileResponse, ipOf, uuidParam } from "@/server/health/http";
import { hidePatientDocument, readPatientDocument } from "@/server/health/records";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const f = await readPatientDocument(await uuidParam(context, "id"), user, ipOf(request));
  return fileResponse(f.data, f.contentType, f.fileName, request.nextUrl.searchParams.get("download") !== "1");
});

export const DELETE = route(async (_r: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  await hidePatientDocument(await uuidParam(context, "id"), user);
  return noContent();
});
