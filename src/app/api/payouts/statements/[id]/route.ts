/**
 * A payout statement (batch-2026-10 WS-E) as PDF (default) or CSV
 * (?format=csv). The shop's owner and finance only; anyone else gets "not found".
 */
import { NextResponse, type NextRequest } from "next/server";

import { AppError, toClientError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { fileResponse, isUuid } from "@/server/payouts/http";
import { canViewStatement, renderPayoutStatement } from "@/server/payouts/statements";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!isUuid(id)) throw new AppError("NOT_FOUND", "Statement not found.");
    const user = await getCurrentUser();
    if (!user) throw new AppError("UNAUTHENTICATED", "Sign in to download this statement.");
    if (!(await canViewStatement(id, user))) throw new AppError("NOT_FOUND", "Statement not found.");
    const doc = await renderPayoutStatement(id);
    if (!doc) throw new AppError("NOT_FOUND", "Statement not found.");
    const csv = new URL(request.url).searchParams.get("format") === "csv";
    return csv ? fileResponse(doc.csv, `${doc.basename}.csv`, "text/csv; charset=utf-8") : fileResponse(doc.pdf, `${doc.basename}.pdf`, "application/pdf");
  } catch (error) {
    const { status, body } = toClientError(error);
    return NextResponse.json(body, { status });
  }
}
