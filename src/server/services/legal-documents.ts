/**
 * Mandatory legal documents by shop category (docs/four-features-2026-10, feature 2).
 *
 *   FSSAI licence          shops that sell food (the food detection seller
 *                          verification already uses: a food shop type or a
 *                          food aisle), plus any extra categories in the rule
 *   Drug licence           pharmacies / medical shops (shop type or category)
 *   Medical registration   doctors / clinics (the "Doctor / Clinic" category)
 *
 * Each needs the number (FSSAI: exactly 14 digits), the expiry date (FSSAI,
 * drug licence) or the issuing council (medical registration), and an
 * uploaded copy, which operations approve or reject with a reason.
 *
 * Gating, with rule legalDocuments on:
 *  - a new shop cannot be approved (go live) until each required document is
 *    submitted;
 *  - a shop that was already live when a requirement first applied to it gets
 *    graceDays (default 15) to upload — it keeps trading meanwhile, with a
 *    clear prompt — and after that it cannot accept orders (checkout refuses
 *    it and the shop cannot accept) until the document is submitted;
 *  - an expired licence gets the same grace from its expiry date; owners are
 *    reminded expiryReminderDays (default 30) before.
 * "Submitted" is enough to trade; a rejection takes that away.
 */
import { createHash } from "node:crypto";

import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import {
  LEGAL_DOC_LABELS,
  LEGAL_DOC_NEEDS,
  checkExpiryDate,
  maskLegalNumber,
  parseLegalDocNumber,
  type LegalDocKey,
  type LegalDocState,
} from "@/lib/legal-documents";
import { formatSlotDay } from "@/lib/scheduled-slots";
import { istToday } from "@/lib/fulfilment-options";
import { decryptBytes, encryptBytes, encryptSecret } from "@/lib/pan-crypto";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import {
  shopCategories,
  shopCategoryMapping,
  shopLegalDocumentFiles,
  shopLegalDocuments,
  shops,
  type LegalDocType,
  type Shop,
  type ShopLegalDocument,
  type UserRole,
} from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { detectDocumentFile, shopSellsFood } from "./seller-verification";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

const DAY_MS = 86_400_000;
const MAX_FILE_BYTES = 5_000_000;

export const isLegalDocReviewer = (actor: Actor) => can(actor.role, PERMISSIONS.SHOP_GST_PAN_VERIFY);

/* ================================================== what a shop needs */

/** The legal documents this shop must hold, from its type, its categories and what it sells. */
export async function requiredLegalDocTypes(shop: Pick<Shop, "id" | "shopType">, client: DbClient = db): Promise<LegalDocType[]> {
  const rule = await getRule("legalDocuments");
  const slugRows = await client
    .select({ slug: shopCategories.slug })
    .from(shopCategoryMapping)
    .innerJoin(shopCategories, eq(shopCategories.id, shopCategoryMapping.categoryId))
    .where(eq(shopCategoryMapping.shopId, shop.id));
  const slugs = slugRows.map((r) => r.slug);
  const inAny = (list: readonly string[]) => slugs.some((s) => list.includes(s));

  const required: LegalDocType[] = [];
  if (inAny(rule.fssaiExtraCategorySlugs) || (await shopSellsFood(shop))) required.push("FSSAI");
  if (rule.drugLicenceShopTypes.includes(shop.shopType) || inAny(rule.drugLicenceCategorySlugs)) required.push("DRUG_LICENCE");
  if (rule.medicalRegistrationShopTypes.includes(shop.shopType) || inAny(rule.medicalRegistrationCategorySlugs)) {
    required.push("MEDICAL_REGISTRATION");
  }
  return required;
}

/** IST end of the day `date` + `days`. */
function endOfDayPlus(date: string, days: number): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 330 * 60_000 + (days + 1) * DAY_MS - 1);
}

export interface LegalDocEvaluation {
  state: LegalDocState;
  /** Submitted or approved, and not expired: enough to trade. */
  satisfied: boolean;
  /** When a missing / rejected / expired document starts blocking orders (null = blocks now unless satisfied). */
  deadline: Date | null;
  /** Blocking orders now. */
  blocking: boolean;
  /** Satisfied but expiring within the reminder window. */
  expiringSoon: boolean;
}

export function evaluateLegalDoc(
  row: Pick<ShopLegalDocument, "status" | "expiryDate" | "graceUntil">,
  rule: { graceDays: number; expiryReminderDays: number },
  now: Date = new Date(),
): LegalDocEvaluation {
  const today = istToday(now);
  const expired = row.expiryDate != null && row.expiryDate < today && (row.status === "SUBMITTED" || row.status === "APPROVED");
  const state: LegalDocState =
    row.status === "NOT_SUBMITTED" ? "MISSING" : row.status === "REJECTED" ? "REJECTED" : expired ? "EXPIRED" : row.status;
  const satisfied = state === "SUBMITTED" || state === "APPROVED";
  const deadline = satisfied ? null : state === "EXPIRED" ? endOfDayPlus(row.expiryDate!, rule.graceDays) : row.graceUntil;
  const reminderFrom = new Date(now.getTime() + rule.expiryReminderDays * DAY_MS).toISOString().slice(0, 10);
  return {
    state,
    satisfied,
    deadline,
    blocking: !satisfied && (deadline == null || deadline.getTime() < now.getTime()),
    expiringSoon: satisfied && row.expiryDate != null && row.expiryDate <= reminderFrom,
  };
}

/**
 * Creates the rows for requirements not seen before. A live shop's new
 * requirement starts its grace period, and the owner is told at once.
 */
async function ensureRows(shop: Shop, required: LegalDocType[], client: DbClient = db): Promise<ShopLegalDocument[]> {
  const rule = await getRule("legalDocuments");
  const existing = await client.select().from(shopLegalDocuments).where(eq(shopLegalDocuments.shopId, shop.id));
  const have = new Set(existing.map((r) => r.docType));
  const created: ShopLegalDocument[] = [];
  for (const docType of required) {
    if (have.has(docType)) continue;
    const live = shop.status === "APPROVED";
    const graceUntil = live ? new Date(Date.now() + rule.graceDays * DAY_MS) : null;
    const [row] = await client
      .insert(shopLegalDocuments)
      .values({ shopId: shop.id, docType, graceUntil })
      .onConflictDoNothing()
      .returning();
    if (!row) continue;
    created.push(row);
    await emitEvent({
      type: "shop.legal_document_required",
      subjectId: shop.id,
      actor: null,
      payload: {
        shopId: shop.id,
        shopName: shop.name,
        ownerId: shop.ownerId,
        docLabel: LEGAL_DOC_LABELS[docType],
        graceUntilLabel: graceUntil ? formatSlotDay(istToday(graceUntil)) : null,
      },
      idempotencyKey: `legal-doc-required:${row.id}`,
    }, client);
  }
  return [...existing, ...created];
}

/* ===================================================== a shop's status */

export interface LegalDocView {
  id: string | null;
  docType: LegalDocType;
  label: string;
  state: LegalDocState;
  numberMasked: string | null;
  issuingCouncil: string | null;
  expiryDate: string | null;
  rejectionReason: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  deadline: string | null;
  blocking: boolean;
  expiringSoon: boolean;
  files: { id: string; contentType: string; createdAt: string }[];
}

export interface ShopLegalStatus {
  enabled: boolean;
  shopId: string;
  shopName: string;
  documents: LegalDocView[];
  /** At least one required document is blocking orders. */
  restricted: boolean;
  /** Earliest deadline among documents still in their grace period. */
  graceUntil: string | null;
}

async function filesFor(documentIds: string[]) {
  if (documentIds.length === 0) return new Map<string, LegalDocView["files"]>();
  const rows = await db
    .select({ id: shopLegalDocumentFiles.id, documentId: shopLegalDocumentFiles.documentId, contentType: shopLegalDocumentFiles.contentType, createdAt: shopLegalDocumentFiles.createdAt })
    .from(shopLegalDocumentFiles)
    .where(inArray(shopLegalDocumentFiles.documentId, documentIds))
    .orderBy(desc(shopLegalDocumentFiles.createdAt));
  const map = new Map<string, LegalDocView["files"]>();
  for (const r of rows) {
    const list = map.get(r.documentId) ?? [];
    list.push({ id: r.id, contentType: r.contentType, createdAt: r.createdAt.toISOString() });
    map.set(r.documentId, list);
  }
  return map;
}

function toView(row: ShopLegalDocument, evaluation: LegalDocEvaluation, files: LegalDocView["files"]): LegalDocView {
  return {
    id: row.id,
    docType: row.docType,
    label: LEGAL_DOC_LABELS[row.docType],
    state: evaluation.state,
    numberMasked: maskLegalNumber(row.numberLast4),
    issuingCouncil: row.issuingCouncil,
    expiryDate: row.expiryDate,
    rejectionReason: row.rejectionReason,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    deadline: evaluation.deadline?.toISOString() ?? null,
    blocking: evaluation.blocking,
    expiringSoon: evaluation.expiringSoon,
    files,
  };
}

/** The shop's required documents and whether it may trade. With the rule off, nothing is required. */
export async function getShopLegalStatus(shopId: string): Promise<ShopLegalStatus> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) throw notFound("Shop");
  const rule = await getRule("legalDocuments");
  if (!rule.enabled) return { enabled: false, shopId, shopName: shop.name, documents: [], restricted: false, graceUntil: null };

  const required = await requiredLegalDocTypes(shop);
  const rows = (await ensureRows(shop, required)).filter((r) => required.includes(r.docType));
  const files = await filesFor(rows.map((r) => r.id));
  const documents = rows
    .sort((a, b) => required.indexOf(a.docType) - required.indexOf(b.docType))
    .map((row) => toView(row, evaluateLegalDoc(row, rule), files.get(row.id) ?? []));
  const pending = documents.filter((d) => !d.blocking && d.deadline != null && (d.state === "MISSING" || d.state === "REJECTED" || d.state === "EXPIRED"));
  return {
    enabled: true,
    shopId,
    shopName: shop.name,
    documents,
    restricted: documents.some((d) => d.blocking),
    graceUntil: pending.map((d) => d.deadline!).sort()[0] ?? null,
  };
}

function listLabels(labels: string[]): string {
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/**
 * Checkout (per shop) and order acceptance: refused while a required document
 * is blocking. Does nothing with the rule off.
 */
export async function assertLegalDocsAllowOrders(shopId: string): Promise<void> {
  if (!(await getRule("legalDocuments")).enabled) return;
  const status = await getShopLegalStatus(shopId);
  if (!status.restricted) return;
  const missing = status.documents.filter((d) => d.blocking).map((d) => d.label);
  throw conflict(
    `${status.shopName} can't take orders until its ${listLabels(missing)} ${missing.length === 1 ? "is" : "are"} uploaded.`,
    { legalDocuments: missing },
  );
}

/**
 * Shop approval (going live): every required document must be submitted first.
 * Pass the approval's transaction — it holds the shop row's lock.
 */
export async function assertLegalDocsAllowApproval(shop: Shop, client: DbClient = db): Promise<void> {
  const rule = await getRule("legalDocuments");
  if (!rule.enabled) return;
  const required = await requiredLegalDocTypes(shop, client);
  if (required.length === 0) return;
  const rows = await ensureRows(shop, required, client);
  const missing = required.filter((type) => {
    const row = rows.find((r) => r.docType === type);
    return !row || !evaluateLegalDoc(row, rule).satisfied;
  });
  if (missing.length > 0) {
    const labels = missing.map((t) => LEGAL_DOC_LABELS[t]);
    throw conflict(`This shop needs its ${listLabels(labels)} uploaded before it can go live.`, { legalDocuments: labels });
  }
}

/* ============================================================ submitting */

export interface SubmitLegalDocInput {
  shopId: string;
  docType: LegalDocKey;
  number: string;
  expiryDate?: string | null;
  issuingCouncil?: string | null;
  file: Buffer;
  actor: Actor;
}

export async function submitLegalDocument(input: SubmitLegalDocInput): Promise<LegalDocView> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, input.shopId) });
  if (!shop || shop.deletedAt) throw notFound("Shop");
  if (shop.ownerId !== input.actor.id && !isLegalDocReviewer(input.actor)) throw forbidden("This shop does not belong to you.");

  const needs = LEGAL_DOC_NEEDS[input.docType];
  const fields: Record<string, string> = {};
  const parsed = parseLegalDocNumber(input.docType, input.number);
  if (!parsed.ok) fields.number = parsed.error;
  let expiryDate: string | null = null;
  if (needs.expiry) {
    const checked = checkExpiryDate(input.expiryDate, istToday());
    if (checked.ok) expiryDate = checked.date;
    else fields.expiryDate = checked.error;
  }
  let council: string | null = null;
  if (needs.council) {
    council = (input.issuingCouncil ?? "").trim().replace(/\s+/g, " ");
    if (council.length < 3 || council.length > 120) fields.issuingCouncil = "Enter the council that issued the registration.";
  }
  if (input.file.length === 0) fields.file = "Attach a copy of the document.";
  const maxBytes = (await getRule("uploads")).sellerDocumentMaxBytes ?? MAX_FILE_BYTES;
  if (input.file.length > maxBytes) fields.file = `The file can be at most ${maxBytes / 1_000_000} MB.`;
  const contentType = input.file.length > 0 ? detectDocumentFile(input.file) : null;
  if (input.file.length > 0 && !contentType) fields.file = "Upload a PDF, JPEG, PNG or WebP file.";
  if (Object.keys(fields).length > 0) {
    throw validationFailed(Object.values(fields)[0], { fields });
  }

  const now = new Date();
  const row = await db.transaction(async (tx) => {
    const values = {
      status: "SUBMITTED" as const,
      numberEncrypted: encryptSecret(parsed.ok ? parsed.normalized : ""),
      numberLast4: parsed.ok ? parsed.last4 : null,
      issuingCouncil: council,
      expiryDate,
      submittedAt: now,
      submittedBy: input.actor.id,
      reviewedAt: null,
      reviewedBy: null,
      rejectionReason: null,
      expiryReminderSentFor: null,
      updatedAt: now,
    };
    const [saved] = await tx
      .insert(shopLegalDocuments)
      .values({ shopId: shop.id, docType: input.docType, ...values })
      .onConflictDoUpdate({ target: [shopLegalDocuments.shopId, shopLegalDocuments.docType], set: values })
      .returning();
    await tx.insert(shopLegalDocumentFiles).values({
      documentId: saved.id,
      shopId: shop.id,
      contentType: contentType!,
      sizeBytes: input.file.length,
      sha256: createHash("sha256").update(input.file).digest("hex"),
      dataEncrypted: encryptBytes(input.file),
      uploadedBy: input.actor.id,
    });
    await recordAudit(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: AUDIT_ACTIONS.SHOP_LEGAL_DOCUMENT_SUBMITTED,
        entityType: "shop_legal_document",
        entityId: saved.id,
        newValue: { shopId: shop.id, docType: input.docType, numberLast4: saved.numberLast4, expiryDate, issuingCouncil: council, contentType },
      },
      tx,
    );
    await emitEvent(
      {
        type: "shop.legal_document_submitted",
        subjectId: shop.id,
        actor: input.actor,
        payload: { shopId: shop.id, shopName: shop.name, ownerId: shop.ownerId, docLabel: LEGAL_DOC_LABELS[input.docType] },
      },
      tx,
    );
    return saved;
  });
  const rule = await getRule("legalDocuments");
  return toView(row, evaluateLegalDoc(row, rule), (await filesFor([row.id])).get(row.id) ?? []);
}

/* ============================================================== review */

export async function decideLegalDocument(
  documentId: string,
  input: { decision: "approve" | "reject"; reason?: string | null },
  actor: Actor,
): Promise<LegalDocView> {
  if (!isLegalDocReviewer(actor)) throw forbidden("Only operations can review legal documents.");
  const reason = input.reason?.trim() ?? "";
  if (input.decision === "reject" && reason.length < 5) {
    throw validationFailed("Give the shop a reason it can act on (at least 5 characters).", { fields: { reason: "Required." } });
  }
  const rule = await getRule("legalDocuments");
  const row = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(shopLegalDocuments).where(eq(shopLegalDocuments.id, documentId)).for("update");
    if (!current) throw notFound("Document");
    if (input.decision === "approve" && current.status !== "SUBMITTED") throw conflict("Only a submitted document can be approved.");
    if (input.decision === "reject" && current.status !== "SUBMITTED" && current.status !== "APPROVED") {
      throw conflict("There is no submitted document to reject.");
    }
    const [shop] = await tx.select().from(shops).where(eq(shops.id, current.shopId));
    const now = new Date();
    // A live shop losing a document for the first time gets one grace period to replace it.
    const graceUntil =
      input.decision === "reject" && current.graceUntil == null && shop?.status === "APPROVED"
        ? new Date(now.getTime() + rule.graceDays * DAY_MS)
        : current.graceUntil;
    const [updated] = await tx
      .update(shopLegalDocuments)
      .set({
        status: input.decision === "approve" ? "APPROVED" : "REJECTED",
        rejectionReason: input.decision === "reject" ? reason : null,
        reviewedAt: now,
        reviewedBy: actor.id,
        graceUntil,
        updatedAt: now,
      })
      .where(eq(shopLegalDocuments.id, documentId))
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_LEGAL_DOCUMENT_DECIDED,
        entityType: "shop_legal_document",
        entityId: documentId,
        previousValue: { status: current.status },
        newValue: { status: updated.status, reason: input.decision === "reject" ? reason : null },
      },
      tx,
    );
    if (shop) {
      await emitEvent(
        {
          type: "shop.legal_document_decided",
          subjectId: shop.id,
          actor,
          payload: {
            shopId: shop.id,
            shopName: shop.name,
            ownerId: shop.ownerId,
            docLabel: LEGAL_DOC_LABELS[current.docType],
            decision: input.decision === "approve" ? "approved" : "rejected",
            reason: input.decision === "reject" ? reason : null,
          },
        },
        tx,
      );
    }
    return updated;
  });
  return toView(row, evaluateLegalDoc(row, rule), (await filesFor([row.id])).get(row.id) ?? []);
}

/** An uploaded licence, for its shop's owner or a reviewer. Reviewer views are audited. */
export async function getLegalDocumentFile(fileId: string, actor: Actor): Promise<{ contentType: string; data: Buffer }> {
  const file = await db.query.shopLegalDocumentFiles.findFirst({ where: eq(shopLegalDocumentFiles.id, fileId) });
  if (!file) throw notFound("File");
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, file.shopId), columns: { ownerId: true } });
  const isOwner = shop?.ownerId === actor.id;
  if (!isOwner && !isLegalDocReviewer(actor)) throw notFound("File");
  if (!isOwner) {
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SHOP_LEGAL_DOCUMENT_FILE_VIEWED,
      entityType: "shop_legal_document",
      entityId: file.documentId,
      newValue: { fileId },
    });
  }
  return { contentType: file.contentType, data: decryptBytes(file.dataEncrypted) };
}

export type ReviewFilter = "to_review" | "rejected" | "approved" | "missing" | "expiring" | "all";

export interface LegalDocReviewRow extends LegalDocView {
  shopId: string;
  shopName: string;
  shopStatus: string;
  city: string;
}

/** The operations screen: documents by state, oldest submission first. */
export async function listLegalDocumentsForReview(filter: ReviewFilter, actor: Actor): Promise<LegalDocReviewRow[]> {
  if (!isLegalDocReviewer(actor)) throw forbidden("Only operations can review legal documents.");
  const rule = await getRule("legalDocuments");
  const soon = new Date(Date.now() + rule.expiryReminderDays * DAY_MS).toISOString().slice(0, 10);
  const where =
    filter === "to_review"
      ? eq(shopLegalDocuments.status, "SUBMITTED")
      : filter === "rejected"
        ? eq(shopLegalDocuments.status, "REJECTED")
        : filter === "approved"
          ? eq(shopLegalDocuments.status, "APPROVED")
          : filter === "missing"
            ? eq(shopLegalDocuments.status, "NOT_SUBMITTED")
            : filter === "expiring"
              ? and(inArray(shopLegalDocuments.status, ["SUBMITTED", "APPROVED"]), lte(shopLegalDocuments.expiryDate, soon))
              : undefined;
  const rows = await db
    .select({ doc: shopLegalDocuments, shopName: shops.name, shopStatus: shops.status, city: shops.city })
    .from(shopLegalDocuments)
    .innerJoin(shops, eq(shops.id, shopLegalDocuments.shopId))
    .where(where)
    .orderBy(asc(sql`coalesce(${shopLegalDocuments.submittedAt}, ${shopLegalDocuments.createdAt})`))
    .limit(300);
  const files = await filesFor(rows.map((r) => r.doc.id));
  return rows.map((r) => ({
    ...toView(r.doc, evaluateLegalDoc(r.doc, rule), files.get(r.doc.id) ?? []),
    shopId: r.doc.shopId,
    shopName: r.shopName,
    shopStatus: r.shopStatus,
    city: r.city,
  }));
}

/* =============================================================== sweep */

/**
 * Daily (run with the seller-verification job): starts the grace period for
 * live shops whose requirement was never seen (telling the owner), and sends
 * the expiry reminder once per expiry date. Idempotent.
 */
export async function runLegalDocumentSweep(now: Date = new Date()): Promise<{ skipped?: true; shopsChecked: number; requirementsStarted: number; remindersSent: number }> {
  const rule = await getRule("legalDocuments");
  if (!rule.enabled) return { skipped: true, shopsChecked: 0, requirementsStarted: 0, remindersSent: 0 };

  const live = await db.select().from(shops).where(and(eq(shops.status, "APPROVED"), isNull(shops.deletedAt))).limit(2000);
  let requirementsStarted = 0;
  for (const shop of live) {
    const before = await db.select({ id: shopLegalDocuments.id }).from(shopLegalDocuments).where(eq(shopLegalDocuments.shopId, shop.id));
    const rows = await ensureRows(shop, await requiredLegalDocTypes(shop));
    requirementsStarted += rows.length - before.length;
  }

  const today = istToday(now);
  const soon = new Date(now.getTime() + rule.expiryReminderDays * DAY_MS).toISOString().slice(0, 10);
  const due = await db
    .select({ doc: shopLegalDocuments, shopName: shops.name, ownerId: shops.ownerId })
    .from(shopLegalDocuments)
    .innerJoin(shops, eq(shops.id, shopLegalDocuments.shopId))
    .where(
      and(
        inArray(shopLegalDocuments.status, ["SUBMITTED", "APPROVED"]),
        gte(shopLegalDocuments.expiryDate, today),
        lte(shopLegalDocuments.expiryDate, soon),
        or(isNull(shopLegalDocuments.expiryReminderSentFor), sql`${shopLegalDocuments.expiryReminderSentFor} <> ${shopLegalDocuments.expiryDate}`),
      ),
    );
  let remindersSent = 0;
  for (const { doc, shopName, ownerId } of due) {
    const [claimed] = await db
      .update(shopLegalDocuments)
      .set({ expiryReminderSentFor: doc.expiryDate, updatedAt: new Date() })
      .where(
        and(
          eq(shopLegalDocuments.id, doc.id),
          or(isNull(shopLegalDocuments.expiryReminderSentFor), sql`${shopLegalDocuments.expiryReminderSentFor} <> ${shopLegalDocuments.expiryDate}`),
        ),
      )
      .returning();
    if (!claimed) continue;
    await emitEvent({
      type: "shop.legal_document_expiring",
      subjectId: doc.shopId,
      actor: null,
      payload: {
        shopId: doc.shopId,
        shopName,
        ownerId,
        docLabel: LEGAL_DOC_LABELS[doc.docType],
        expiryLabel: formatSlotDay(doc.expiryDate!),
      },
      idempotencyKey: `legal-doc-expiring:${doc.id}:${doc.expiryDate}`,
    });
    remindersSent += 1;
  }
  return { shopsChecked: live.length, requirementsStarted, remindersSent };
}
