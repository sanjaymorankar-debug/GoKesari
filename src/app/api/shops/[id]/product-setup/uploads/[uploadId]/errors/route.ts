/** The rows that could not be imported, with an Error column; correct them and upload this file again. */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { buildErrorFile } from "@/server/services/shop-bulk-upload";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string; uploadId: string }>) => {
  const user = await requireUser();
  const params = await context.params;
  const file = await buildErrorFile(z.string().uuid().parse(params.id), z.string().uuid().parse(params.uploadId), user);
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
