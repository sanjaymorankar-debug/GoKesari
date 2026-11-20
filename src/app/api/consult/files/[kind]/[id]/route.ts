/**
 * GET ?exp&sig — a private booking file or a consultant's registration certificate. Needs both a valid
 * five-minute signature (issued to this viewer) and the viewer's session and access; each download by the
 * firm or staff is written to consult_access_logs.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { forbidden } from "@/lib/errors";
import { route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { checkSignature, readBookingFile, readMemberDocument } from "@/server/consult/files";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ kind: string; id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`consult-file-read:${user.id}`, RATE_LIMITS.SELLER_DOCUMENT_READ);
  const params = await context.params;
  const kind = z.enum(["booking", "member"]).parse(params.kind);
  const id = z.string().uuid().parse(params.id);
  const exp = Number(request.nextUrl.searchParams.get("exp"));
  const sig = request.nextUrl.searchParams.get("sig") ?? "";
  if (!checkSignature(kind, id, user.id, exp, sig)) throw forbidden("This link has expired. Open the file again from the booking.");
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const file = kind === "booking" ? await readBookingFile(id, user, ip) : await readMemberDocument(id, user, ip);
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `inline; filename="${file.fileName.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
