/**
 * GET — the prescription PDF behind a medicine order: the patient side, or the medical store it was sent
 * to (not after the request expired). Every store download is written to the patient's access log.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { rxOrderPrescriptionPdf } from "@/server/health/rx-orders";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const { pdf, filename } = await rxOrderPrescriptionPdf(z.string().uuid().parse((await context.params).id), user, ip);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.length),
      "Content-Disposition": `inline; filename="${filename.replace(/[^\w.\-]+/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
