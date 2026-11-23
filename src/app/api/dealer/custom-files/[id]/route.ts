/** docs/dealer-platform phase 5: GET a scheme-question file — its dealer, or staff (audited). */
import { NextResponse } from "next/server";

import { route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { customFileContent } from "@/server/dealers/custom-fields";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: Request, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const file = await customFileContent((await context.params).id, user);
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: { "content-type": file.mimeType, "content-disposition": `attachment; filename="${file.fileName.replace(/"/g, "")}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
});
