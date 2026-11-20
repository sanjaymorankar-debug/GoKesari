/** GET — the GST tax invoice (PDF) of a paid GoKesari Health Prime plan: the shop's owner, or Health staff. */
import type { NextRequest } from "next/server";

import { route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { fileResponse, uuidParam } from "@/server/health/http";
import { primeInvoicePdf } from "@/server/health/prime-invoice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(async (request: NextRequest, context: RouteContext<{ subscriptionId: string }>) => {
  const user = await requireUser();
  const id = await uuidParam(context, "subscriptionId");
  const { pdf, filename } = await primeInvoicePdf(id, user);
  return fileResponse(pdf, "application/pdf", filename, request.nextUrl.searchParams.get("download") !== "1") as never;
});
