/** Billing v2: download a generated return's JSON (GSTR-8 / GSTR-1 / GSTR-3B / TDS). STATUTORY_MANAGE. */
import { NextResponse, type NextRequest } from "next/server";

import { notFound } from "@/lib/errors";
import { route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { isUuid } from "@/server/payouts/http";
import { getFiling } from "@/server/tax/compliance";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requirePermission(PERMISSIONS.STATUTORY_MANAGE);
  const { id } = await context.params;
  if (!isUuid(id)) throw notFound("Filing");
  const filing = await getFiling(id);
  return new NextResponse(JSON.stringify(filing.payload, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${filing.returnType}-${filing.period}.json"`,
      "cache-control": "private, no-store",
      "x-checksum-sha256": filing.checksum,
    },
  });
});
