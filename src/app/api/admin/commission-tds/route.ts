/**
 * TDS on commission (gap report Part D). ADMIN and CA (permission checks again in the services).
 *
 * GET ?view=settings → dated rows, certificates, challans, exceptions
 *     ?view=deductions&month=YYYY-MM[&format=csv] → monthly TDS per payee
 *     ?view=26q&fy=2026-27&quarter=1-4[&format=csv] → quarterly 26Q data with full PANs (audited)
 *     ?view=16a&fy=&quarter= → the Form 16A tracker · ?view=16a-file&id= → one PDF
 * POST { action, … }:
 *   addRate {payeeType, panStatus, rateBp, thresholdPaise, mode, section, effectiveFrom, note?} (STATUTORY_MANAGE)
 *   confirmRate {id, confirmed, note?} (confirm: the CA only; withdraw: STATUTORY_MANAGE)
 *   addCertificate {panHash, payeeLabel, certificateNumber, rateBp, validFrom, validTo, limitPaise?, note?}
 *   withdrawCertificate {id, reason} · addChallan {periodMonth, section, amountPaise, bsrCode, challanSerial, depositedOn, note?}
 *   uploadForm16a {panHash, payeeLabel, financialYear, quarter, certificateNumber, fileName, base64}
 *   overrideBlock {batchId, reason} (ADMIN: pay a payout whose TDS row is unconfirmed)
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { forbidden } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { toCsv } from "@/server/integrations/tabular";
import {
  addCommissionTdsRate,
  addTdsCertificate,
  addTdsChallan,
  form16aFile,
  form16aTracker,
  listCommissionTdsRates,
  listTdsCertificates,
  listTdsChallans,
  overrideTdsBlock,
  setCommissionTdsConfirmation,
  tdsDeductions,
  tdsExceptions,
  uploadForm16a,
  withdrawTdsCertificate,
} from "@/server/tax/commission-tds";

export const dynamic = "force-dynamic";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("addRate"),
    payeeType: z.enum(["INDIVIDUAL", "FIRM", "COMPANY", "ANY"]),
    panStatus: z.enum(["PAN_OK", "NO_PAN"]),
    rateBp: z.number().int(),
    thresholdPaise: z.number().int(),
    mode: z.enum(["CATCH_UP", "EXCESS_ONLY"]),
    section: z.string().max(300),
    effectiveFrom: day,
    note: z.string().max(500).nullish(),
  }),
  z.object({ action: z.literal("confirmRate"), id: z.string().uuid(), confirmed: z.boolean(), note: z.string().max(500).nullish() }),
  z.object({
    action: z.literal("addCertificate"),
    panHash: z.string().min(8).max(200),
    payeeLabel: z.string().max(200),
    certificateNumber: z.string().max(60),
    rateBp: z.number().int(),
    validFrom: day,
    validTo: day,
    limitPaise: z.number().int().nullish(),
    note: z.string().max(500).nullish(),
  }),
  z.object({ action: z.literal("withdrawCertificate"), id: z.string().uuid(), reason: z.string().max(500) }),
  z.object({ action: z.literal("addChallan"), periodMonth: month, section: z.string().max(300), amountPaise: z.number().int(), bsrCode: z.string().max(7), challanSerial: z.string().max(20), depositedOn: day, note: z.string().max(500).nullish() }),
  z.object({
    action: z.literal("uploadForm16a"),
    panHash: z.string().min(8).max(200),
    payeeLabel: z.string().max(200),
    financialYear: z.string().regex(/^\d{4}-\d{2}$/),
    quarter: z.number().int().min(1).max(4),
    certificateNumber: z.string().max(60),
    fileName: z.string().max(120),
    base64: z.string().max(7_000_000),
  }),
  z.object({ action: z.literal("overrideBlock"), batchId: z.string().uuid(), reason: z.string().max(500) }),
]);

async function staff() {
  const user = await requireUser();
  if (!can(user.role, PERMISSIONS.COMMISSION_TDS_MANAGE) && !can(user.role, PERMISSIONS.STATUTORY_MANAGE)) throw forbidden("Only an admin or the CA can see TDS on commission.");
  return { id: user.id, role: user.role };
}

const csvResponse = (name: string, header: string[], rows: (string | number | null)[][]) =>
  new NextResponse(new Uint8Array(toCsv(header, rows)), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store" } });

export const GET = route(async (request: NextRequest) => {
  const actor = await staff();
  const p = request.nextUrl.searchParams;
  const view = p.get("view") ?? "settings";
  if (view === "deductions" || view === "26q") {
    const withPan = view === "26q";
    const rows = await tdsDeductions(withPan ? { financialYear: p.get("fy") ?? "", quarter: Number(p.get("quarter")) } : { month: month.parse(p.get("month")) }, actor, withPan);
    if (p.get("format") === "csv") {
      return csvResponse(
        withPan ? `26Q-${p.get("fy")}-Q${p.get("quarter")}.csv` : `commission-tds-${p.get("month")}.csv`,
        ["Month", "Payee", withPan ? "PAN" : "PAN (masked)", "Section", "Amount paid / credited (Rs)", "TDS (Rs)", "Rate %", "Paid on", "Certificate", "Challan (BSR / serial / date)", "Flag", "Status"],
        rows.map((r) => [r.periodMonth, r.payeeName, withPan ? r.pan : r.panMasked, r.section, r.grossPaise / 100, r.tdsPaise / 100, r.rateBp / 100, r.paidOn, r.certificate, r.challan, r.flag, r.status]),
      );
    }
    return ok({ rows: rows.map((r) => ({ ...r, pan: undefined })) });
  }
  if (view === "16a") return ok({ rows: await form16aTracker(p.get("fy") ?? "", Number(p.get("quarter")), actor) });
  if (view === "16a-file") {
    const file = await form16aFile(z.string().uuid().parse(p.get("id")), { actor, panHash: null });
    return new NextResponse(new Uint8Array(file.bytes), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${file.fileName}"`, "cache-control": "private, no-store" } });
  }
  const [rates, certificates, challans, exceptions] = await Promise.all([listCommissionTdsRates(), listTdsCertificates(), listTdsChallans(), tdsExceptions(actor)]);
  return ok({ rates, certificates, challans, exceptions });
});

export const POST = route(async (request: NextRequest) => {
  const actor = await staff();
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "addRate":
      return ok({ rate: await addCommissionTdsRate(body, actor) });
    case "confirmRate":
      return ok({ rate: await setCommissionTdsConfirmation(body.id, body.confirmed, actor, body.note) });
    case "addCertificate":
      return ok({ certificate: await addTdsCertificate(body, actor) });
    case "withdrawCertificate":
      await withdrawTdsCertificate(body.id, body.reason, actor);
      return ok({ done: true });
    case "addChallan":
      return ok({ challan: await addTdsChallan(body, actor) });
    case "uploadForm16a": {
      return ok(await uploadForm16a({ ...body, bytes: Buffer.from(body.base64, "base64") }, actor));
    }
    case "overrideBlock":
      await overrideTdsBlock(body.batchId, body.reason, actor);
      return ok({ done: true });
  }
});
