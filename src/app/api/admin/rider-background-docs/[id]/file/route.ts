/**
 * Gig worker flow (feature 3): the file of one police verification form or
 * character certificate — ADMIN only, never cached, every opening audited.
 */
import { NextResponse, type NextRequest } from "next/server";

import { route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { getBackgroundDocFile } from "@/server/services/rider-background-docs";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireRole("ADMIN");
  const { id } = await context.params;
  const file = await getBackgroundDocFile(id, user);
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `inline; filename="${file.fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
