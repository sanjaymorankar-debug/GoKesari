/**
 * RBAC v2 documents: the file behind a signed link (no session needed: the link itself is the permission and expires
 * after a few minutes). Served as an attachment, never inline, and never cached.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { route } from "@/server/api/handler";
import { readByLink } from "@/server/rbac-support/documents";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const token = request.nextUrl.searchParams.get("t") ?? "";
  const file = await readByLink(token);
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "content-type": file.contentType,
      "content-disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"`,
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
    },
  });
});
