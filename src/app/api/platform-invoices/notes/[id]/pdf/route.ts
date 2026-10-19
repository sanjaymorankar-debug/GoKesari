/** A credit or debit note on GoKesari's fee invoice, as a PDF (shop owner and finance only). */
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { AppError, toClientError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { platformCreditDebitNotes } from "@/server/db/schema";
import { fileResponse, isUuid } from "@/server/payouts/http";
import { canViewPlatformDocument, renderPlatformNotePdf } from "@/server/platform-invoices/service";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!isUuid(id)) throw new AppError("NOT_FOUND", "Note not found.");
    const user = await getCurrentUser();
    if (!user) throw new AppError("UNAUTHENTICATED", "Sign in to download this note.");
    const [note] = await db.select().from(platformCreditDebitNotes).where(eq(platformCreditDebitNotes.id, id));
    if (!note || !(await canViewPlatformDocument(note.shopId, user))) throw new AppError("NOT_FOUND", "Note not found.");
    return fileResponse(renderPlatformNotePdf(note), `${note.noteNumber.replace(/[^A-Za-z0-9-]+/g, "_")}.pdf`, "application/pdf");
  } catch (error) {
    const { status, body } = toClientError(error);
    return NextResponse.json(body, { status });
  }
}
