/** GET → the fee receipt as a PDF, once the registration is approved. */
import { NextResponse, type NextRequest } from "next/server";

import { toClientError } from "@/lib/errors";
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
    const { status, body } = toClientError(error);
    return NextResponse.json(body, { status });
  }
}
