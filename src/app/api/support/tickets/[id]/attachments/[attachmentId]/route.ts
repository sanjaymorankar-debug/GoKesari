/**
 * Serve a ticket file to whoever may see the ticket (staff-only files to
 * support only). Never cached publicly; sandboxed.
 */
import { NextResponse, type NextRequest } from "next/server";

import { toClientError } from "@/lib/errors";
import { requireUser } from "@/server/authz/guards";
import { readTicketAttachment } from "@/server/aftercare/support-tickets";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string; attachmentId: string }> }) {
  try {
    const { id, attachmentId } = await context.params;
    const file = await readTicketAttachment(id, attachmentId, await requireUser());
    return new NextResponse(new Uint8Array(file.data), {
      headers: {
        "Content-Type": file.contentType,
        "Content-Length": String(file.sizeBytes),
        "Content-Disposition": `inline; filename="${file.fileName.replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    const { status, body } = toClientError(error);
    return NextResponse.json(body, { status });
  }
}
