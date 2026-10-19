/**
 * GoKesari's fee invoice to a shop as a PDF (batch-2026-10 WS-E). The shop's
 * owner and finance only; anyone else gets "not found".
 */
import { NextResponse, type NextRequest } from "next/server";

import { AppError, toClientError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { fileResponse, isUuid } from "@/server/payouts/http";
import { canViewPlatformDocument, renderPlatformInvoiceById } from "@/server/platform-invoices/service";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!isUuid(id)) throw new AppError("NOT_FOUND", "Invoice not found.");
    const user = await getCurrentUser();
    if (!user) throw new AppError("UNAUTHENTICATED", "Sign in to download this invoice.");
    const doc = await renderPlatformInvoiceById(id);
    if (!doc || !(await canViewPlatformDocument(doc.shopId, user))) throw new AppError("NOT_FOUND", "Invoice not found.");
    return fileResponse(doc.pdf, doc.filename, "application/pdf");
  } catch (error) {
    const { status, body } = toClientError(error);
    return NextResponse.json(body, { status });
  }
}
