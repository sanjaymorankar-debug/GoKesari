/**
 * Bank bulk-upload payout file for an approved batch (PAYOUT_MANAGE) —
 * generic NEFT/RTGS CSV (columns in server/payouts/batches.ts; the bank's
 * exact template must be confirmed). Exporting moves the batch's payments to
 * "being paid"; finance then marks each paid with its UTR. POST because it
 * changes state; the file comes back as the response body.
 */
import type { NextRequest } from "next/server";

import { notFound } from "@/lib/errors";
import { route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { exportBankFile } from "@/server/payouts/batches";
import { fileResponse, isUuid } from "@/server/payouts/http";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.PAYOUT_MANAGE);
  const { id } = await context.params;
  if (!isUuid(id)) throw notFound("Payout batch");
  const file = await exportBankFile(id, user);
  const response = fileResponse(file.csv, file.filename, "text/csv; charset=utf-8");
  response.headers.set("X-Payout-Rows", String(file.rows));
  response.headers.set("X-Payout-Skipped", String(file.skipped.length));
  return response;
});
