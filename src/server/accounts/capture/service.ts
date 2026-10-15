/**
 * Supplier bill capture (docs/inventory-accounting-2026-10, Parts 4–6): the
 * job queue, the review draft and the confirm step.
 *
 *   upload / scan / share / email → files stored → capture QUEUED
 *   → the job runs (right after the upload, and a cron safety net picks up
 *     anything left): PROCESSING with progress → READY_FOR_REVIEW, and the
 *     owner is notified
 *   → the owner reviews and edits the draft (side by side with the bill)
 *   → Confirm: confirmPurchase in one transaction. Nothing touches stock
 *     before this.
 *
 * Jobs are claimed with FOR UPDATE SKIP LOCKED, so two runners never read the
 * same bill; a job stuck in PROCESSING for 10 minutes (a server restart) is
 * picked up again, at most three attempts.
 */
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { computeTotals, draftToPurchase, emptyDraft, hasErrors, validateDraft, type BillDraft, type DraftIssue } from "@/lib/accounts/bill-draft";
import type { CaptureKind, CaptureSource } from "@/lib/accounts/constants";
import { stateOfGstin } from "@/lib/accounts/gst-math";
import { db } from "@/server/db";
import { accFiles, invBillCaptures, shops, type InvBillCapture } from "@/server/db/schema";
import { notify } from "@/server/services/notifications";
import { logChange } from "../books";
import { putFile, readBytes, sniffContentType, MAX_FILE_BYTES } from "../files";
import { confirmPurchase, findDuplicate, type PurchaseActor } from "../purchases";
import { extractBill } from "./extract";
import { matchDraft, refreshConversions } from "./match";

export const MAX_PAGES = 10;
const STUCK_MINUTES = 10;
const MAX_ATTEMPTS = 3;

export interface UploadedFile {
  bytes: Buffer;
  contentType: string | null;
  name: string | null;
}

export async function createCapture(shopId: string, input: { files: UploadedFile[]; kind: CaptureKind; source: CaptureSource }, actorId: string | null): Promise<InvBillCapture> {
  if (input.files.length === 0) throw validationFailed("Add the bill: a PDF, photo, Excel sheet or e-invoice JSON.");
  if (input.files.length > MAX_PAGES) throw validationFailed(`At most ${MAX_PAGES} pages per bill.`);
  const total = input.files.reduce((n, f) => n + f.bytes.length, 0);
  if (total > MAX_FILE_BYTES * 2) throw validationFailed("These files are too large together (20 MB at most).");
  const stored = [];
  for (const [i, file] of input.files.entries()) {
    const type = sniffContentType(file.bytes, file.contentType, file.name);
    if (!type || type === "text/plain") throw validationFailed(`"${file.name ?? `File ${i + 1}`}" is not a PDF, photo, spreadsheet or e-invoice JSON.`);
    if (type === "image/heic") throw validationFailed("HEIC photos cannot be read. In the camera settings choose 'Most compatible' (JPEG), or use Scan bill.");
    stored.push(await putFile({ shopId, purpose: "BILL", bytes: file.bytes, contentType: type, originalName: file.name, pageNo: i + 1, uploadedBy: actorId }));
  }
  const [capture] = await db
    .insert(invBillCaptures)
    .values({ shopId, kind: input.kind, source: input.source, status: "QUEUED", progress: 5, stage: "Waiting to be read", fileIds: stored.map((f) => f.id), createdBy: actorId })
    .returning();
  await logChange({ shopId, entityType: "bill_capture", entityId: capture.id, action: "UPLOAD", snapshot: { files: stored.length, kind: input.kind, source: input.source }, actorId });
  return capture;
}

async function setProgress(id: string, progress: number, stage: string): Promise<void> {
  await db.update(invBillCaptures).set({ progress, stage, updatedAt: new Date() }).where(eq(invBillCaptures.id, id));
}

/** Claims one capture for reading; null when someone else has it or it is not waiting. */
async function claim(id: string): Promise<InvBillCapture | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(invBillCaptures)
      .where(
        and(
          eq(invBillCaptures.id, id),
          or(eq(invBillCaptures.status, "QUEUED"), and(eq(invBillCaptures.status, "PROCESSING"), lt(invBillCaptures.lockedAt, new Date(Date.now() - STUCK_MINUTES * 60_000)))),
          lt(invBillCaptures.attempts, MAX_ATTEMPTS),
        ),
      )
      .for("update", { skipLocked: true });
    if (!row) return null;
    const [claimed] = await tx
      .update(invBillCaptures)
      .set({ status: "PROCESSING", lockedAt: new Date(), attempts: row.attempts + 1, progress: 10, stage: "Starting", updatedAt: new Date() })
      .where(eq(invBillCaptures.id, id))
      .returning();
    return claimed;
  });
}

/** Reads one bill (the job). Never throws: a failure is recorded on the capture. */
export async function processCapture(id: string): Promise<InvBillCapture | null> {
  const capture = await claim(id);
  if (!capture) return null;
  try {
    const [shop] = await db.select({ gstin: shops.gstin, name: shops.name, ownerId: shops.ownerId }).from(shops).where(eq(shops.id, capture.shopId));
    const files = await db.select().from(accFiles).where(and(eq(accFiles.shopId, capture.shopId), inArray(accFiles.id, capture.fileIds)));
    const ordered = capture.fileIds.map((fid) => files.find((f) => f.id === fid)).filter((f): f is NonNullable<typeof f> => Boolean(f));
    const inputs = [];
    for (const file of ordered) inputs.push({ bytes: await readBytes(file), contentType: file.contentType, name: file.originalName });
    const { draft, engine } = await extractBill(inputs, { buyerStateCode: stateOfGstin(shop?.gstin), ownGstin: shop?.gstin ?? null }, (p, s) => setProgress(id, p, s));
    await setProgress(id, 90, "Matching your products");
    const matched = await matchDraft(capture.shopId, draft);
    const issues = await checkDraft(capture.shopId, matched);
    const [done] = await db
      .update(invBillCaptures)
      .set({ status: "READY_FOR_REVIEW", progress: 100, stage: "Ready to check", engine, draft: matched as unknown as Record<string, unknown>, issues, error: null, lockedAt: null, updatedAt: new Date() })
      .where(eq(invBillCaptures.id, id))
      .returning();
    if (shop && capture.createdBy) {
      const label = [matched.supplierName.value, matched.invoiceNo.value].filter(Boolean).join(" · ") || "from your upload";
      await notify({
        userId: capture.createdBy,
        type: "shop.bill_ready",
        title: "Bill ready to check",
        body: `Your bill ${label} has been read (${matched.lines.length} item${matched.lines.length === 1 ? "" : "s"}). Check it and confirm to add the stock.`,
        actionUrl: `/shop/accounts/bills/${id}`,
        dedupeKey: `bill-ready:${id}`,
      });
    }
    return done;
  } catch (error) {
    console.error("[bill-capture] reading failed", id, (error as Error).message);
    const [failed] = await db
      .update(invBillCaptures)
      .set({ status: "FAILED", progress: 100, stage: "Could not be read", error: (error as Error).message.slice(0, 500), lockedAt: null, updatedAt: new Date() })
      .where(eq(invBillCaptures.id, id))
      .returning();
    return failed;
  }
}

/** Runs waiting jobs (cron safety net and after each upload). */
export async function dispatchCaptures(limit = 5): Promise<{ processed: number }> {
  const waiting = await db
    .select({ id: invBillCaptures.id })
    .from(invBillCaptures)
    .where(
      and(
        or(eq(invBillCaptures.status, "QUEUED"), and(eq(invBillCaptures.status, "PROCESSING"), lt(invBillCaptures.lockedAt, new Date(Date.now() - STUCK_MINUTES * 60_000)))),
        lt(invBillCaptures.attempts, MAX_ATTEMPTS),
      ),
    )
    .orderBy(asc(invBillCaptures.createdAt))
    .limit(limit);
  let processed = 0;
  for (const w of waiting) if (await processCapture(w.id)) processed += 1;
  return { processed };
}

/** Every check, including the duplicate one the database answers. */
export async function checkDraft(shopId: string, draft: BillDraft): Promise<DraftIssue[]> {
  const issues = validateDraft(draft);
  const dup = await findDuplicate(shopId, draft.supplierGstin.value, draft.supplierName.value, draft.invoiceNo.value);
  if (dup) issues.unshift({ code: "DUPLICATE", severity: "error", field: "invoiceNo", message: `This bill is already in your books (same supplier and invoice number, dated ${dup.invoiceDate}).` });
  return issues;
}

/* ------------------------------------------------------------ owner side */

export async function getCapture(shopId: string, id: string): Promise<InvBillCapture> {
  const [row] = await db.select().from(invBillCaptures).where(and(eq(invBillCaptures.id, id), eq(invBillCaptures.shopId, shopId)));
  if (!row) throw notFound("Bill");
  return row;
}

export async function listCaptures(shopId: string, status?: InvBillCapture["status"][]) {
  return db
    .select({ id: invBillCaptures.id, status: invBillCaptures.status, kind: invBillCaptures.kind, source: invBillCaptures.source, progress: invBillCaptures.progress, stage: invBillCaptures.stage, engine: invBillCaptures.engine, createdAt: invBillCaptures.createdAt, purchaseInvoiceId: invBillCaptures.purchaseInvoiceId, supplier: sql<string | null>`${invBillCaptures.draft} -> 'supplierName' ->> 'value'`, invoiceNo: sql<string | null>`${invBillCaptures.draft} -> 'invoiceNo' ->> 'value'`, pages: sql<number>`cardinality(${invBillCaptures.fileIds})` })
    .from(invBillCaptures)
    .where(and(eq(invBillCaptures.shopId, shopId), status ? inArray(invBillCaptures.status, status) : undefined))
    .orderBy(desc(invBillCaptures.createdAt))
    .limit(100);
}

export async function countToReview(shopId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(invBillCaptures).where(and(eq(invBillCaptures.shopId, shopId), inArray(invBillCaptures.status, ["READY_FOR_REVIEW", "QUEUED", "PROCESSING"])));
  return Number(row?.n ?? 0);
}

/** Saves the owner's edits (auto-save from the review screen) and re-checks them. */
export async function saveDraft(shopId: string, id: string, draft: BillDraft): Promise<{ draft: BillDraft; issues: DraftIssue[]; totals: ReturnType<typeof computeTotals> }> {
  const capture = await getCapture(shopId, id);
  if (capture.status !== "READY_FOR_REVIEW" && capture.status !== "FAILED") throw conflict(capture.status === "CONFIRMED" ? "This bill is already confirmed. Open it from Purchases to correct it." : "This bill is still being read.");
  const refreshed = await refreshConversions(shopId, draft);
  const issues = await checkDraft(shopId, refreshed);
  await db
    .update(invBillCaptures)
    .set({ draft: refreshed as unknown as Record<string, unknown>, issues, status: "READY_FOR_REVIEW", updatedAt: new Date() })
    .where(eq(invBillCaptures.id, id));
  return { draft: refreshed, issues, totals: computeTotals(refreshed) };
}

export async function discardCapture(shopId: string, id: string, actorId: string): Promise<void> {
  const capture = await getCapture(shopId, id);
  if (capture.status === "CONFIRMED") throw conflict("A confirmed bill cannot be discarded. Cancel the purchase instead.");
  await db.update(invBillCaptures).set({ status: "DISCARDED", updatedAt: new Date() }).where(eq(invBillCaptures.id, id));
  await logChange({ shopId, entityType: "bill_capture", entityId: id, action: "DISCARD", actorId });
}

export async function retryCapture(shopId: string, id: string): Promise<void> {
  const capture = await getCapture(shopId, id);
  if (capture.status !== "FAILED") throw conflict("Only a bill that could not be read can be read again.");
  await db.update(invBillCaptures).set({ status: "QUEUED", attempts: 0, progress: 5, stage: "Waiting to be read", error: null, updatedAt: new Date() }).where(eq(invBillCaptures.id, id));
}

export async function confirmCapture(shopId: string, id: string, draft: BillDraft, actor: PurchaseActor) {
  const capture = await getCapture(shopId, id);
  const refreshed = await refreshConversions(shopId, draft);
  const issues = await checkDraft(shopId, refreshed);
  await db.update(invBillCaptures).set({ draft: refreshed as unknown as Record<string, unknown>, issues, updatedAt: new Date() }).where(eq(invBillCaptures.id, id));
  if (hasErrors(issues)) throw validationFailed("Fix the items marked in red before confirming.", { issues });
  const purchase = await confirmPurchase(shopId, draftToPurchase(refreshed), actor, { captureId: id, fileIds: capture.fileIds, engine: capture.engine ?? "MANUAL" });
  // Feedback for the reader: which fields the owner changed (by confidence band), for tuning.
  await logChange({ shopId, entityType: "bill_capture", entityId: id, action: "CONFIRM", snapshot: { purchaseId: purchase.id, engine: capture.engine, lines: refreshed.lines.length }, actorId: actor.id });
  return purchase;
}

/** A blank capture for typing a paper bill without a photo. */
export async function createManualCapture(shopId: string, actorId: string): Promise<InvBillCapture> {
  const [shop] = await db.select({ gstin: shops.gstin }).from(shops).where(eq(shops.id, shopId));
  const draft = emptyDraft(stateOfGstin(shop?.gstin));
  const [capture] = await db
    .insert(invBillCaptures)
    .values({ shopId, kind: "HARD", source: "UPLOAD", status: "READY_FOR_REVIEW", progress: 100, stage: "Type the bill", engine: "MANUAL", fileIds: [], draft: draft as unknown as Record<string, unknown>, issues: validateDraft(draft), createdBy: actorId })
    .returning();
  return capture;
}
