/**
 * Inventory & Accounting API (docs/inventory-accounting-2026-10): every
 * endpoint of the module under /api/shops/{shopId}/accounts/…, routed here.
 * Each handler stays thin — parse, authorize, call a service, respond — and
 * every one starts with requireAccountsAccess(shopId): the shop's owner, or
 * an administrator for support. Services filter every query by that shop.
 */
import { after, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { notFound, validationFailed } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import type { BillDraft } from "@/lib/accounts/bill-draft";
import { requireAccountsAccess } from "@/server/accounts/access";
import { getSettings, updateSettings } from "@/server/accounts/books";
import { readFileForShop } from "@/server/accounts/files";
import {
  gstLiability,
  getPortalLink,
  importFromPortal,
  importPortalFile,
  listImports,
  providerSummary,
  reconciliationView,
  requestLinkOtp,
  runReconciliation,
  unlinkPortal,
  verifyLinkOtp,
} from "@/server/accounts/gst";
import { cancelExpense, cancelPayment, cashBook, dayBook, expenseSchema, listExpenses, listPayments, paymentSchema, recordExpense, recordPayment } from "@/server/accounts/money";
import { ageing, createParty, getParty, listParties, partyLedger, partySchema, updateParty } from "@/server/accounts/parties";
import { cancelPurchase, confirmPurchase, correctPurchase, getPurchase, listPurchases, purchaseAsInput, purchaseSchema } from "@/server/accounts/purchases";
import { reportTable, tableToPdf, tableToXlsx, tallyXml, type ReportKind } from "@/server/accounts/reports";
import { cancelDocument, createDocument, documentPdf, documentSchema, getDocument, listDocuments } from "@/server/accounts/documents";
import { salesReceiptPdf } from "@/server/invoicing/outputs";
import { shopStatementFiles } from "@/server/tax/statements";
import { requireFeature } from "@/server/services/feature-flags";
import { cancelSalesInvoice, createSalesInvoice, getSalesInvoice, listSalesInvoices, salesInvoicePdf, salesSchema } from "@/server/accounts/sales";
import { adjustStockTo, expiringBatches, ledgerDrift, listingLedger, listListings, setTrackBatches, stockSummary, writeOffStock } from "@/server/accounts/stock";
import {
  confirmCapture,
  createCapture,
  createManualCapture,
  discardCapture,
  getCapture,
  listCaptures,
  processCapture,
  retryCapture,
  saveDraft,
  checkDraft,
} from "@/server/accounts/capture/service";
import { computeTotals } from "@/lib/accounts/bill-draft";
import { db } from "@/server/db";
import { ACC_DOCUMENT_KINDS, accChangeLog, type UserRole } from "@/server/db/schema";
import { and, desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = RouteContext<{ id: string; path: string[] }>;
type Handler = (req: NextRequest, shopId: string, user: { id: string; role: UserRole }, params: string[]) => Promise<NextResponse>;

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const q = (req: NextRequest, key: string) => req.nextUrl.searchParams.get(key) ?? undefined;
const id = (raw: string | undefined) => uuid.parse(raw);

function file(bytes: Buffer, contentType: string, filename: string): NextResponse {
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function formFiles(req: NextRequest): Promise<{ files: { bytes: Buffer; contentType: string | null; name: string | null }[]; fields: Record<string, string> }> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw validationFailed("Send the bill as a file upload.");
  }
  const files = [];
  const fields: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") fields[key] = value;
    else files.push({ bytes: Buffer.from(await value.arrayBuffer()), contentType: value.type || null, name: value.name || null });
  }
  return { files, fields };
}

const TOP: Record<string, { GET?: Handler; POST?: Handler; PATCH?: Handler; PUT?: Handler; DELETE?: Handler }> = {
  /* ------------------------------------- documents (billing v2, §4.1) */
  documents: {
    GET: async (req, shopId, _u, [did, action]) => {
      await requireFeature("billing_v2");
      if (!did) {
        const kind = q(req, "kind");
        return ok(await listDocuments(shopId, { kind: kind ? z.enum(ACC_DOCUMENT_KINDS).parse(kind) : undefined, from: q(req, "from"), to: q(req, "to") }));
      }
      if (action === "pdf") {
        const pdf = await documentPdf(shopId, id(did));
        return file(pdf.bytes, "application/pdf", pdf.filename);
      }
      return ok(await getDocument(shopId, id(did)));
    },
    POST: async (req, shopId, user) => {
      await requireFeature("billing_v2");
      return ok(await createDocument(shopId, await parseBody(req, documentSchema), user), 201);
    },
    DELETE: async (req, shopId, user, [did]) => {
      await requireFeature("billing_v2");
      const body = await parseBody(req, z.object({ reason: z.string().trim().min(1).max(300) }));
      return ok(await cancelDocument(shopId, id(did), body.reason, user));
    },
  },

  /* ----------------- statements from GoKesari (billing v2, §5.4–5.6) */
  statements: {
    GET: async (req, shopId, _u, [kind]) => {
      await requireFeature("billing_v2");
      const k = z.enum(["wallet", "tax", "settlement"]).parse(kind);
      const p = period.parse(q(req, "period"));
      const format = z.enum(["pdf", "csv"]).parse(q(req, "format") ?? (k === "settlement" ? "csv" : "pdf"));
      const f = await shopStatementFiles(shopId, k, p, format);
      return file(f.bytes, f.contentType, f.filename);
    },
  },

  /* ---------------------------------------------------------- settings */
  settings: {
    GET: async (_r, shopId) => ok(await getSettings(shopId)),
    PATCH: async (req, shopId, user) => {
      const body = await parseBody(
        req,
        z.object({
          valuationMethod: z.enum(["FIFO", "WAVG"]).optional(),
          purchaseChannel: z.enum(["ONLINE", "OFFLINE"]).optional(),
          filingFrequency: z.enum(["MONTHLY", "QUARTERLY"]).optional(),
          salesInvoicePrefix: z.string().optional(),
          reminderDaysBefore: z.number().int().min(0).max(30).optional(),
          expiryAlertDays: z.number().int().min(0).max(365).optional(),
          upiVpa: z.string().trim().max(300).nullable().optional(),
        }),
      );
      return ok(await updateSettings(shopId, body, user.id));
    },
  },

  /* ------------------------------------------------------------- bills */
  bills: {
    GET: async (req, shopId, _u, [captureId, action]) => {
      if (!captureId) {
        const status = q(req, "status");
        return ok(await listCaptures(shopId, status ? (status.split(",") as never) : undefined));
      }
      const capture = await getCapture(shopId, id(captureId));
      if (action === "status") return ok({ id: capture.id, status: capture.status, progress: capture.progress, stage: capture.stage, error: capture.error, purchaseInvoiceId: capture.purchaseInvoiceId });
      const draft = capture.draft as unknown as BillDraft | null;
      return ok({ ...capture, totals: draft ? computeTotals(draft) : null });
    },
    POST: async (req, shopId, user, [captureId, action]) => {
      if (!captureId) {
        enforceRateLimit(clientKey(req, `bills:${shopId}`), { limit: 30, windowMs: 10 * 60_000 });
        const { files, fields } = await formFiles(req);
        const capture = await createCapture(shopId, { files, kind: fields.kind === "HARD" ? "HARD" : "SOFT", source: fields.source === "CAMERA" ? "CAMERA" : fields.source === "SHARE" ? "SHARE" : "UPLOAD" }, user.id);
        // Read right after the response; the cron picks up anything a restart interrupts.
        after(() => processCapture(capture.id).then(() => undefined));
        return ok(capture, 201);
      }
      if (captureId === "manual") return ok(await createManualCapture(shopId, user.id), 201);
      const cid = id(captureId);
      if (action === "confirm") {
        const body = await parseBody(req, z.object({ draft: z.unknown() }));
        const purchase = await confirmCapture(shopId, cid, body.draft as BillDraft, user);
        return ok(purchase, 201);
      }
      if (action === "retry") {
        await retryCapture(shopId, cid);
        after(() => processCapture(cid).then(() => undefined));
        return ok({ queued: true });
      }
      if (action === "check") {
        const body = await parseBody(req, z.object({ draft: z.unknown() }));
        const draft = body.draft as BillDraft;
        return ok({ issues: await checkDraft(shopId, draft), totals: computeTotals(draft) });
      }
      throw notFound("Action");
    },
    PATCH: async (req, shopId, _user, [captureId]) => {
      const body = await parseBody(req, z.object({ draft: z.unknown() }));
      return ok(await saveDraft(shopId, id(captureId), body.draft as BillDraft));
    },
    DELETE: async (_req, shopId, user, [captureId]) => {
      await discardCapture(shopId, id(captureId), user.id);
      return ok({ discarded: true });
    },
  },

  files: {
    GET: async (_req, shopId, _u, [fileId]) => {
      const { file: f, bytes } = await readFileForShop(shopId, id(fileId));
      const inline = f.contentType.startsWith("image/") || f.contentType === "application/pdf";
      const res = file(bytes, f.contentType, f.originalName ?? `bill-${f.id}`);
      if (inline) res.headers.set("content-disposition", "inline");
      // Images: nothing but the picture. (A sandbox would also stop the browser's PDF viewer, so PDFs get none.)
      if (f.contentType.startsWith("image/")) res.headers.set("content-security-policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      return res;
    },
  },

  /* --------------------------------------------------------- purchases */
  purchases: {
    GET: async (req, shopId, _u, [pid, action]) => {
      if (!pid) return ok(await listPurchases(shopId, { from: q(req, "from"), to: q(req, "to"), partyId: q(req, "partyId") }));
      const purchaseId = id(pid);
      if (action === "edit") return ok(await purchaseAsInput(shopId, purchaseId));
      const detail = await getPurchase(shopId, purchaseId);
      const history = await db.select().from(accChangeLog).where(and(eq(accChangeLog.shopId, shopId), eq(accChangeLog.entityId, purchaseId))).orderBy(desc(accChangeLog.createdAt));
      return ok({ ...detail, history });
    },
    POST: async (req, shopId, user) => ok(await confirmPurchase(shopId, await parseBody(req, purchaseSchema), user), 201),
    PUT: async (req, shopId, user, [pid]) => {
      const body = await parseBody(req, z.object({ purchase: purchaseSchema, reason: z.string().trim().max(300).nullable().optional() }));
      return ok(await correctPurchase(shopId, id(pid), body.purchase, user, body.reason ?? null));
    },
    DELETE: async (req, shopId, user, [pid]) => {
      const body = await parseBody(req, z.object({ reason: z.string().trim().min(1).max(300) }));
      await cancelPurchase(shopId, id(pid), user, body.reason);
      return ok({ cancelled: true });
    },
  },

  /* -------------------------------------------------------------- sales */
  sales: {
    GET: async (req, shopId, _u, [sid, action]) => {
      if (!sid) return ok(await listSalesInvoices(shopId, { from: q(req, "from"), to: q(req, "to") }));
      if (action === "pdf") {
        const pdf = await salesInvoicePdf(shopId, id(sid));
        return file(pdf.bytes, "application/pdf", pdf.filename);
      }
      // Billing v2 (§4.6): 80 mm receipt with the shop's UPI payment QR.
      if (action === "receipt") {
        await requireFeature("billing_v2");
        const pdf = await salesReceiptPdf(shopId, id(sid));
        return file(pdf.bytes, "application/pdf", pdf.filename);
      }
      return ok(await getSalesInvoice(shopId, id(sid)));
    },
    POST: async (req, shopId, user) => ok(await createSalesInvoice(shopId, await parseBody(req, salesSchema), user), 201),
    DELETE: async (req, shopId, user, [sid]) => {
      const body = await parseBody(req, z.object({ reason: z.string().trim().min(1).max(300) }));
      await cancelSalesInvoice(shopId, id(sid), body.reason, user);
      return ok({ cancelled: true });
    },
  },

  /* ------------------------------------------------------------ parties */
  parties: {
    GET: async (req, shopId, _u, [pid]) => {
      if (!pid) return ok(await listParties(shopId, (q(req, "kind") as never) ?? "ALL"));
      return ok(await partyLedger(shopId, id(pid)));
    },
    POST: async (req, shopId, user) => ok(await createParty(shopId, await parseBody(req, partySchema), user.id), 201),
    PATCH: async (req, shopId, user, [pid]) => {
      await getParty(shopId, id(pid));
      return ok(await updateParty(shopId, id(pid), await parseBody(req, partySchema.partial()), user.id));
    },
  },

  ageing: {
    GET: async (req, shopId) => ok(await ageing(shopId, q(req, "side") === "RECEIVABLE" ? "RECEIVABLE" : "PAYABLE")),
  },

  payments: {
    GET: async (req, shopId) => ok(await listPayments(shopId, { partyId: q(req, "partyId") })),
    POST: async (req, shopId, user) => ok(await recordPayment(shopId, await parseBody(req, paymentSchema), user.id), 201),
    DELETE: async (req, shopId, user, [pid]) => {
      const body = await parseBody(req, z.object({ reason: z.string().trim().min(1).max(300) }));
      await cancelPayment(shopId, id(pid), body.reason, user.id);
      return ok({ cancelled: true });
    },
  },

  expenses: {
    GET: async (req, shopId) => ok(await listExpenses(shopId, { from: q(req, "from"), to: q(req, "to") })),
    POST: async (req, shopId, user) => ok(await recordExpense(shopId, await parseBody(req, expenseSchema), user.id), 201),
    DELETE: async (req, shopId, user, [eid]) => {
      const body = await parseBody(req, z.object({ reason: z.string().trim().min(1).max(300) }));
      await cancelExpense(shopId, id(eid), body.reason, user.id);
      return ok({ cancelled: true });
    },
  },

  books: {
    GET: async (req, shopId, _u, [kind]) => {
      const from = isoDate.parse(q(req, "from"));
      const to = isoDate.parse(q(req, "to"));
      if (kind === "cash" || kind === "bank") return ok(await cashBook(shopId, kind === "cash" ? "CASH" : "BANK", from, to));
      if (kind === "day") return ok(await dayBook(shopId, from, to));
      throw notFound("Book");
    },
  },

  /* -------------------------------------------------------------- stock */
  stock: {
    GET: async (req, shopId, _u, [spId]) => {
      if (!spId) return ok(await stockSummary(shopId, { asOf: q(req, "asOf") }));
      if (spId === "expiring") return ok(await expiringBatches(shopId));
      if (spId === "listings") return ok(await listListings(shopId));
      if (spId === "drift") return ok(await ledgerDrift(shopId));
      return ok(await listingLedger(shopId, id(spId)));
    },
    POST: async (req, shopId, user, [spId, action]) => {
      const listingId = id(spId);
      if (action === "write-off") {
        const body = await parseBody(req, z.object({ qtyMilli: z.number().int().positive(), kind: z.enum(["DAMAGE", "EXPIRY"]), batchId: uuid.nullable().optional(), note: z.string().trim().max(300).nullable().optional() }));
        return ok({ id: await writeOffStock(shopId, { shopProductId: listingId, ...body }, user.id) }, 201);
      }
      if (action === "count") {
        const body = await parseBody(req, z.object({ countedMilli: z.number().int().min(0), note: z.string().trim().max(300).nullable().optional() }));
        return ok(await adjustStockTo(shopId, listingId, body.countedMilli, body.note ?? null, user.id));
      }
      if (action === "batches") {
        const body = await parseBody(req, z.object({ track: z.boolean() }));
        await setTrackBatches(shopId, listingId, body.track);
        return ok({ track: body.track });
      }
      throw notFound("Action");
    },
  },

  /* ---------------------------------------------------------------- GST */
  gst: {
    GET: async (req, shopId, _u, [what]) => {
      if (what === "link") return ok({ link: await getPortalLink(shopId), ...providerSummary() });
      if (what === "imports") return ok(await listImports(shopId));
      if (what === "recon") return ok(await reconciliationView(shopId, period.parse(q(req, "period"))));
      if (what === "liability") return ok(await gstLiability(shopId, period.parse(q(req, "period")), (q(req, "frequency") as never) ?? undefined));
      throw notFound("GST");
    },
    POST: async (req, shopId, user, [what]) => {
      if (what === "link") {
        const body = await parseBody(req, z.object({ gstin: z.string(), username: z.string(), consent: z.boolean() }));
        return ok(await requestLinkOtp(shopId, body, user.id));
      }
      if (what === "verify") {
        enforceRateLimit(clientKey(req, `gst-otp:${shopId}`), { limit: 5, windowMs: 10 * 60_000 });
        const body = await parseBody(req, z.object({ otp: z.string().trim().regex(/^\d{4,8}$/) }));
        return ok(await verifyLinkOtp(shopId, body.otp, user.id));
      }
      if (what === "pull") {
        const body = await parseBody(req, z.object({ returnType: z.enum(["GSTR2B", "GSTR2A", "GSTR1"]), period }));
        return ok(await importFromPortal(shopId, body.returnType, body.period, user.id));
      }
      if (what === "import") {
        const { files, fields } = await formFiles(req);
        if (files.length !== 1) throw validationFailed("Choose the one file you downloaded from gst.gov.in.");
        const rt = fields.returnType && ["GSTR2B", "GSTR2A", "GSTR1"].includes(fields.returnType) ? (fields.returnType as "GSTR2B") : undefined;
        return ok(await importPortalFile(shopId, { bytes: files[0].bytes, fileName: files[0].name ?? "return.json", contentType: files[0].contentType ?? "", returnType: rt, period: period.parse(fields.period) }, user.id), 201);
      }
      if (what === "recon") {
        const body = await parseBody(req, z.object({ period }));
        return ok(await runReconciliation(shopId, body.period));
      }
      throw notFound("GST");
    },
    DELETE: async (_req, shopId, user, [what]) => {
      if (what !== "link") throw notFound("GST");
      await unlinkPortal(shopId, user.id);
      return ok({ unlinked: true });
    },
  },

  /* ------------------------------------------------------------ reports */
  reports: {
    GET: async (req, shopId, _u, [kind]) => {
      const from = isoDate.parse(q(req, "from"));
      const to = isoDate.parse(q(req, "to"));
      const format = q(req, "format") ?? "json";
      if (kind === "tally") return file(Buffer.from(await tallyXml(shopId, from, to, q(req, "company")), "utf8"), "application/xml", `gokesari-tally-${from}-to-${to}.xml`);
      const k = z.enum(["pnl", "stock", "daybook", "purchases", "sales", "gst", "ledger"]).parse(kind) as ReportKind;
      const table = await reportTable(shopId, k, from, to);
      if (format === "xlsx") return file(await tableToXlsx(table), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", `${k}-${from}-to-${to}.xlsx`);
      if (format === "pdf") return file(tableToPdf(table), "application/pdf", `${k}-${from}-to-${to}.pdf`);
      return ok(table);
    },
  },
};

function dispatch(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE") {
  return route(async (req: NextRequest, context: Ctx) => {
    const { id: shopId, path } = await context.params;
    uuid.parse(shopId);
    const { user } = await requireAccountsAccess(shopId);
    const [top, ...rest] = path;
    const handler = TOP[top]?.[method];
    if (!handler) throw notFound("Endpoint");
    return handler(req, shopId, user, rest);
  });
}

export const GET = dispatch("GET");
export const POST = dispatch("POST");
export const PATCH = dispatch("PATCH");
export const PUT = dispatch("PUT");
export const DELETE = dispatch("DELETE");
