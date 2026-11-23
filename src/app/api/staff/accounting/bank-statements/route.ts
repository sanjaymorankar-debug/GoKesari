/**
 * RBAC v2 Phase 3: bank statements. GET (Accountant, CA, Admin) the list; POST (Accountant) a statement file as
 * multipart form fields file (.csv / .xlsx) and accountLabel ("HDFC current ••1234"). With preview=1 the file is
 * only read: its lines, row problems and warnings come back and nothing is saved.
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { requireAnyPermission, requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { assertBankReconViewer, importStatement, listStatements, previewStatement } from "@/server/rbac-accounting/bank-reconciliation";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const actor = await requireAnyPermission([PERMISSIONS.BANK_RECON_PREPARE, PERMISSIONS.BANK_RECON_SIGNOFF]);
  await assertBankReconViewer(actor);
  return ok(await listStatements());
});

export const POST = route(async (request: NextRequest) => {
  const actor = await requirePermission(PERMISSIONS.BANK_RECON_PREPARE);
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) throw validationFailed("Choose the bank statement file (.csv or .xlsx).");
  const buffer = Buffer.from(await file.arrayBuffer());
  if (String(form?.get("preview") ?? "") === "1") {
    const parsed = await previewStatement({ file: buffer, filename: file.name }, actor);
    return ok({ ...parsed, lines: parsed.lines.slice(0, 20), lineCount: parsed.lines.length });
  }
  return ok(await importStatement({ accountLabel: String(form?.get("accountLabel") ?? ""), file: buffer, filename: file.name }, actor), 201);
});
