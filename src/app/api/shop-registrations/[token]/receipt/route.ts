/** GET → the fee receipt as a PDF, once the registration is approved. */
import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/server/api/handler";
import { registrationReceiptPdf } from "@/server/registration/service";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    const pdf = await registrationReceiptPdf(token);
    return new NextResponse(new Uint8Array(pdf.body), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${pdf.fileName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
