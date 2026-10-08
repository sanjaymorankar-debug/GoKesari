/** An uploaded legal document — its shop's owner or a reviewer only (reviewer views audited); never cached. */
import { NextResponse, type NextRequest } from "next/server";

import { route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { getLegalDocumentFile } from "@/server/services/legal-documents";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ fileId: string }>) => {
  const { fileId } = await context.params;
  const user = await requireUser();
  const file = await getLegalDocumentFile(fileId, user);
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
