/**
 * GET — one dealer document's file: the dealer's own, or any for an ADMIN (audited).
 * Anyone else gets 404. docs/dealer-programme, GKS-DR-002.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { dealerDocumentFile } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireDealerProgramme();
  const user = await requireUser();
  const id = z.string().uuid().parse((await context.params).id);
  const file = await dealerDocumentFile(id, user);
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "content-type": file.mimeType,
      "content-disposition": `inline; filename="${file.fileName.replace(/"/g, "")}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
