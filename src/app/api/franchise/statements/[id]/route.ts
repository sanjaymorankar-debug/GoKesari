/** GET ?format=pdf|csv — a monthly franchise statement (the dealer's own, or any for staff). */
import { NextResponse, type NextRequest } from "next/server";

import { route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { statementCsv, statementForViewer, statementPdf } from "@/server/franchise/statements";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, { params }: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const d = await statementForViewer((await params).id, user);
  const name = `franchise-statement-${d.snap.month}-${d.snap.code ?? d.snap.zoneId}`;
  if (new URL(request.url).searchParams.get("format") === "csv") {
    return new NextResponse(statementCsv(d), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"` } });
  }
  return new NextResponse(new Uint8Array(statementPdf(d)), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${name}.pdf"` } });
});
