/** GET — the store's bill for a completed medicine order (PDF from the patient's record). Patient side or that store. */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { rxBillPdf } from "@/server/health/rx-orders";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { pdf, filename } = await rxBillPdf(z.string().uuid().parse((await context.params).id), user);
  const inline = request.nextUrl.searchParams.get("download") !== "1";
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename.replace(/[^\w.\-]+/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
