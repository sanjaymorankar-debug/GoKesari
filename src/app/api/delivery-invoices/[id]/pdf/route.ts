/**
 * Billing v2 (docs/billing §5.2): GoKesari's s.9(5) delivery-fee invoice as a
 * PDF. The customer it was issued to, and operations; anyone else "not found".
 */
import { NextResponse, type NextRequest } from "next/server";

import { AppError, toClientError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { canViewDeliveryFeeInvoice, getDeliveryFeeInvoice, renderDeliveryFeeInvoicePdf } from "@/server/tax/delivery-invoice";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("NOT_FOUND", "Invoice not found.");
    const user = await getCurrentUser();
    if (!user) throw new AppError("UNAUTHENTICATED", "Sign in to download this invoice.");
    const invoice = await getDeliveryFeeInvoice(id);
    if (!canViewDeliveryFeeInvoice(invoice, user)) throw new AppError("NOT_FOUND", "Invoice not found.");
    const pdf = renderDeliveryFeeInvoicePdf(invoice);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(pdf.length),
        "Content-Disposition": `attachment; filename="${invoice.invoiceNumber.replace(/[^A-Za-z0-9-]+/g, "_")}.pdf"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const { status, body } = toClientError(error);
    return NextResponse.json(body, { status });
  }
}
