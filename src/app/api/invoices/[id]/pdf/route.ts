/**
 * NEW-007: download an invoice as a PDF. The order's customer, its shop's
 * owner and operations only; anyone else gets "not found".
 */
import { NextResponse, type NextRequest } from "next/server";

import { AppError, toClientError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { canViewInvoice, getInvoice, renderInvoicePdf } from "@/server/services/invoices";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("NOT_FOUND", "Invoice not found.");
    const user = await getCurrentUser();
    if (!user) throw new AppError("UNAUTHENTICATED", "Sign in to download this invoice.");
    const invoice = await getInvoice(id);
    if (!(await canViewInvoice(invoice, user))) throw new AppError("NOT_FOUND", "Invoice not found.");
    const pdf = renderInvoicePdf(invoice);
    const filename = `${invoice.invoiceNumber.replace(/[^A-Za-z0-9-]+/g, "_")}.pdf`;
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(pdf.length),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const { status, body } = toClientError(error);
    return NextResponse.json(body, { status });
  }
}
