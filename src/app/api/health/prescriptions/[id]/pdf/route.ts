/** The prescription PDF (?print=1: the clinic's print copy on its letterhead mode; ?download=1). Logged. */
import type { NextRequest } from "next/server";

import { noContent, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { fileResponse, ipOf, uuidParam } from "@/server/health/http";
import { logPrescriptionPrint, prescriptionPdf } from "@/server/health/prescriptions";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const print = request.nextUrl.searchParams.get("print") === "1";
  if (print && request.nextUrl.searchParams.get("log") === "1") {
    // The HTML print view was printed: log it without building a PDF.
    await logPrescriptionPrint(await uuidParam(context, "id"), user, ipOf(request));
    return noContent();
  }
  const { pdf, filename } = await prescriptionPdf(await uuidParam(context, "id"), user, print ? "PRINT" : "DOWNLOAD", ipOf(request));
  return fileResponse(pdf, "application/pdf", filename, request.nextUrl.searchParams.get("download") !== "1");
});
