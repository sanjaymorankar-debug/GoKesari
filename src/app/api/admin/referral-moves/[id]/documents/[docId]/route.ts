/** Admin: GET one consent letter of a referral move (decrypted, never cached). */
import { NextResponse, type NextRequest } from "next/server";

import { route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { readMoveDocument } from "@/server/dealers/referral-moves";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, { params }: RouteContext<{ id: string; docId: string }>) => {
  const admin = await requireRole("ADMIN");
  const { id, docId } = await params;
  const f = await readMoveDocument(id, docId, admin);
  return new NextResponse(new Uint8Array(f.bytes), {
    headers: { "Content-Type": f.mimeType, "Content-Disposition": `inline; filename="${f.fileName}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
});
