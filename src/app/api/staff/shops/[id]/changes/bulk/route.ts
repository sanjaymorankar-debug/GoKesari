/**
 * RBAC v2 Phase 4: upload the edited price list (CSV / XLSX, form fields file, reason, ticketId). Good rows become
 * one change request for the owner; rows with problems come back with an error report (CSV text).
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { errorReportCsv, proposeBulkFile } from "@/server/rbac-support/bulk";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requirePermission(PERMISSIONS.SHOP_CHANGE_PROPOSE);
  const { id } = await context.params;
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) throw validationFailed("Choose the edited template (.csv or .xlsx).");
  const reason = String(form?.get("reason") ?? "").trim();
  const ticketId = String(form?.get("ticketId") ?? "").trim() || null;
  const result = await proposeBulkFile({ shopId: id, ticketId, reason: reason || "Price list from the shop owner", file: Buffer.from(await file.arrayBuffer()), filename: file.name }, actor);
  return ok({ ...result, errorReport: result.errors.length ? errorReportCsv(result.errors) : null }, result.request ? 201 : 200);
});
