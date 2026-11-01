/**
 * Billing v2 (docs/billing §4.6): an invoice as machine-readable JSON
 * ("gokesari.invoice/1", amounts in paise). Same access as the PDF.
 */
import { NextResponse, type NextRequest } from "next/server";

import { AppError, toClientError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { invoiceJson } from "@/server/invoicing/outputs";
import { canViewInvoice, getInvoice } from "@/server/services/invoices";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("NOT_FOUND", "Invoice not found.");
    const user = await getCurrentUser();
    if (!user) throw new AppError("UNAUTHENTICATED", "Sign in to download this invoice.");
    const invoice = await getInvoice(id);
    if (!(await canViewInvoice(invoice, user))) throw new AppError("NOT_FOUND", "Invoice not found.");
    const body = await invoiceJson(invoice);
    return NextResponse.json(body, {
      headers: {
        "Content-Disposition": `attachment; filename="${invoice.invoiceNumber.replace(/[^A-Za-z0-9-]+/g, "_")}.json"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    const { status, body } = toClientError(error);
    return NextResponse.json(body, { status });
  }
}
