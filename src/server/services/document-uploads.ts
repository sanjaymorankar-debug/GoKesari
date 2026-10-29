/**
 * Shop document upload with auto-read (Task 2) and the FSSAI rule for food
 * shops (Task 3) — docs/document-upload-2026-10/README.md.
 *
 *   1. read     the owner uploads a file or takes a photo; the server stores
 *               it encrypted, reads it (document-reader.ts), pulls out the
 *               fields and flags problems (document-extract.ts).
 *   2. review   the owner sees the fields pre-filled, corrects them if the
 *               reader got something wrong, and clicks Verify & Approve.
 *   3. confirm  the server re-checks the fields and hands the document to the
 *               existing flows: seller verification (PAN, GSTIN, Udyam, FSSAI,
 *               Shop Act — vendor check and admin review as before) and/or the
 *               legal-documents register (FSSAI, drug licence, medical
 *               registration, and the optional licences: trade licence, legal
 *               metrology, fire NOC, seeds / fertiliser / pesticide, Other). The file moves to that flow's file table, where
 *               admins and operators already open it (every view audited).
 *
 * "Scan a document" sends docType AUTO: the reader works out which document it
 * is (detectUploadType) and the upload is filed under that type, exactly as if
 * the owner had used its card. When it can't tell, nothing is stored and the
 * owner is asked to use the card.
 *
 * Nothing the reader returns is trusted: an unreadable, wrong or expired
 * document is refused with a request to re-upload, and fields the owner
 * changed are recorded so a reviewer can see them.
 */
import { createHash } from "node:crypto";

import { and, count, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";

import {
  AUTO_DETECT,
  assessExtraction,
  checkDocNumber,
  detectUploadType,
  extractDocumentFields,
  isSellerDocType,
  NOT_READ_FLAG,
  UPLOAD_DOC_LABELS,
  UPLOAD_DOC_TYPES,
  validateConfirmedFields,
  type ConfirmedFields,
  type ExtractedFields,
  type ExtractionFlag,
  type UploadDocType,
} from "@/lib/kyc/document-extract";
import { looksLikeAadhaar } from "@/lib/kyc/doc-formats";
import { isAdditionalLicence } from "@/lib/legal-documents";
import { istToday } from "@/lib/fulfilment-options";
import { conflict, forbidden, notFound, validationFailed, AppError } from "@/lib/errors";
import { decryptBytes, decryptSecret, encryptBytes, encryptSecret } from "@/lib/pan-crypto";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import {
  sellerDocumentUploads,
  sellerVerificationFiles,
  sellerVerifications,
  shopLegalDocuments,
  shops,
  type SellerDocumentUpload,
  type Shop,
  type UserRole,
} from "@/server/db/schema";
import { readDocument, type BrowserReadInput } from "@/server/kyc/document-reader";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { legalDocLabel, requiredLegalDocTypes, submitLegalDocument } from "./legal-documents";
import {
  detectDocumentFile,
  getShopVerificationSummary,
  shopSellsFood,
  submitSellerDocument,
  uploadShopActCertificate,
} from "./seller-verification";
import { getRule } from "./settings";

export interface Actor {
  id: string;
  role: UserRole;
}

const isReviewer = (actor: Actor) => can(actor.role, PERMISSIONS.SHOP_GST_PAN_VERIFY);

async function loadShopFor(shopId: string, actor: Actor, client: DbClient = db): Promise<Shop> {
  const [shop] = await client.select().from(shops).where(eq(shops.id, shopId));
  if (!shop || shop.deletedAt) throw notFound("Shop");
  if (shop.ownerId !== actor.id && !isReviewer(actor)) throw forbidden("This shop does not belong to you.");
  return shop;
}

function decryptJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(decryptSecret(value)) as T;
  } catch {
    return null;
  }
}

/* ================================================================ views */

export interface UploadView {
  id: string;
  docType: UploadDocType;
  label: string;
  status: SellerDocumentUpload["status"];
  source: SellerDocumentUpload["source"];
  contentType: string;
  readerEngine: string;
  readerConfidence: number | null;
  /** What the reader found — pre-fills the review form. */
  fields: ExtractedFields | null;
  /** What the owner submitted (after confirm). */
  confirmed: (ConfirmedFields & { issuingCouncil?: string | null; licenceName?: string | null }) | null;
  flags: ExtractionFlag[];
  blocking: boolean;
  fieldsCorrected: string[];
  validUntil: string | null;
  numberLast4: string | null;
  verificationId: string | null;
  legalDocumentId: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
}

function toUploadView(row: SellerDocumentUpload): UploadView {
  return {
    id: row.id,
    docType: row.docType,
    label: UPLOAD_DOC_LABELS[row.docType],
    status: row.status,
    source: row.source,
    contentType: row.contentType,
    readerEngine: row.readerEngine,
    readerConfidence: row.readerConfidence,
    fields: decryptJson<ExtractedFields>(row.extractedEncrypted),
    confirmed: decryptJson<ConfirmedFields>(row.confirmedEncrypted),
    flags: row.flags as ExtractionFlag[],
    blocking: row.blocking,
    fieldsCorrected: row.fieldsCorrected,
    validUntil: row.validUntil,
    numberLast4: row.numberLast4,
    verificationId: row.verificationId,
    legalDocumentId: row.legalDocumentId,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
  };
}

/* ============================================================ checklist */

export type ChecklistRequirement = "required" | "required_or_declaration" | "optional";

export interface ChecklistItem {
  docType: UploadDocType;
  label: string;
  requirement: ChecklistRequirement;
  /** Seller-verification status (PAN, GSTIN…), or the legal-document status, or NOT_SUBMITTED. */
  status: string;
  validUntil: string | null;
  /** The newest upload not discarded, if any. */
  latest: UploadView | null;
  /** True when this document no longer needs anything from the owner. */
  done: boolean;
  /** One of the optional licences (trade licence, legal metrology, fire NOC, seeds / fertiliser / pesticide, Other). */
  additional: boolean;
  /** Other licence: the names of those already submitted. */
  held: string[];
}

export interface DocumentChecklist {
  shop: { id: string; name: string; sellsFood: boolean };
  items: ChecklistItem[];
  /** Mandatory documents still to upload or confirm. */
  missing: UploadDocType[];
  fssaiRequired: boolean;
  fssaiOnFile: boolean;
  enabled: boolean;
}

/** Statuses that count as "the owner has done their part" for a document. */
const SELLER_DONE = new Set(["VERIFIED", "PENDING", "MANUAL_REVIEW"]);
const LEGAL_DONE = new Set(["SUBMITTED", "APPROVED"]);

export async function getDocumentChecklist(shopId: string, actor: Actor): Promise<DocumentChecklist> {
  const shop = await loadShopFor(shopId, actor);
  const rule = await getRule("documentUpload");
  const summary = await getShopVerificationSummary(shopId, actor);
  const legalRequired = await requiredLegalDocTypes(shop);
  const legalRule = await getRule("legalDocuments");
  const legalRows = await db.select().from(shopLegalDocuments).where(eq(shopLegalDocuments.shopId, shopId));
  const uploads = await db
    .select()
    .from(sellerDocumentUploads)
    .where(and(eq(sellerDocumentUploads.shopId, shopId), inArray(sellerDocumentUploads.status, ["EXTRACTED", "CONFIRMED"])))
    .orderBy(desc(sellerDocumentUploads.createdAt));
  const sellsFood = summary.isFoodBusiness;
  const fssai = await fssaiStatus(shop);

  const items: ChecklistItem[] = [];
  for (const docType of UPLOAD_DOC_TYPES) {
    const latestRow = uploads.find((u) => u.docType === docType) ?? null;
    let requirement: ChecklistRequirement | null = null;
    let status = "NOT_SUBMITTED";
    let validUntil: string | null = null;
    let done = false;
    if (isSellerDocType(docType)) {
      const doc = summary.documents.find((d) => d.docType === docType);
      if (doc && doc.requirement !== "not_applicable") requirement = doc.requirement;
      if (doc) {
        status = doc.status;
        validUntil = doc.validUntil;
        done = SELLER_DONE.has(doc.status) && (!doc.validUntil || doc.validUntil >= istToday());
      }
    }
    if (docType === "FSSAI" || docType === "DRUG_LICENCE" || docType === "MEDICAL_REGISTRATION") {
      const legal = legalRows.find((r) => r.docType === docType);
      const legalNeeded = legalRequired.includes(docType);
      if (legalNeeded) requirement = legalRule.enabled || docType === "FSSAI" ? "required" : (requirement ?? "optional");
      if (legal && docType !== "FSSAI") {
        status = legal.status;
        validUntil = legal.expiryDate;
        done = LEGAL_DONE.has(legal.status) && (!legal.expiryDate || legal.expiryDate >= istToday());
      }
    }
    const held: string[] = [];
    if (isAdditionalLicence(docType)) {
      const rows = legalRows
        .filter((r) => r.docType === docType && r.status !== "NOT_SUBMITTED")
        .sort((a, b) => (b.submittedAt?.getTime() ?? 0) - (a.submittedAt?.getTime() ?? 0));
      requirement = legalRule.enabled && legalRequired.includes(docType) ? "required" : "optional";
      const legal = rows[0];
      if (legal) {
        status = legal.status;
        validUntil = legal.expiryDate;
        done = LEGAL_DONE.has(legal.status) && (!legal.expiryDate || legal.expiryDate >= istToday());
      }
      if (docType === "OTHER_LICENCE") {
        held.push(...rows.map((r) => legalDocLabel(r)));
        // Any number of other licences: the card always takes one more.
        done = false;
      }
    }
    // A scanned document waiting for review always gets its card, needed or not.
    const awaitingReview = latestRow?.status === "EXTRACTED";
    if (docType === "FSSAI") {
      // Only food shops (or shops the legal-documents rule names) are asked for FSSAI at all.
      if (!sellsFood && !legalRequired.includes("FSSAI") && !awaitingReview) continue;
      if (sellsFood && rule.fssaiMandatoryForFood) requirement = "required";
      done = fssai.onFile;
      validUntil = fssai.validUntil ?? validUntil;
    }
    if ((docType === "UDYAM" || awaitingReview) && !requirement) requirement = "optional";
    if (!requirement) continue;
    items.push({
      docType,
      label: UPLOAD_DOC_LABELS[docType],
      requirement,
      status,
      validUntil,
      latest: latestRow ? toUploadView(latestRow) : null,
      done,
      additional: isAdditionalLicence(docType),
      held,
    });
  }
  return {
    shop: { id: shop.id, name: shop.name, sellsFood },
    items,
    missing: items.filter((i) => i.requirement !== "optional" && !i.done).map((i) => i.docType),
    fssaiRequired: sellsFood && rule.fssaiMandatoryForFood,
    fssaiOnFile: fssai.onFile,
    enabled: rule.enabled,
  };
}

/* ================================================================ read */

export interface ReadUploadInput {
  shopId: string;
  docType: string;
  file: Buffer;
  source?: "FILE" | "CAMERA";
  /** Text the owner's browser read from a photo (src/lib/kyc/browser-ocr.ts); checked like any other read. */
  browserRead?: BrowserReadInput | null;
  actor: Actor;
}

export async function readUploadedDocument(input: ReadUploadInput): Promise<UploadView> {
  const rule = await getRule("documentUpload");
  if (!rule.enabled) throw conflict("Document upload is switched off. Use the verification page to enter the numbers.");
  const auto = input.docType === AUTO_DETECT;
  if (!auto && !(UPLOAD_DOC_TYPES as readonly string[]).includes(input.docType)) throw validationFailed("Unknown document type.");
  const shop = await loadShopFor(input.shopId, input.actor);

  if (input.file.length === 0) throw validationFailed("The file is empty.");
  if (input.file.length > rule.maxUploadBytes) {
    throw validationFailed(`The file can be at most ${rule.maxUploadBytes / 1_000_000} MB. Take the photo again at a lower size or upload a smaller PDF.`);
  }
  const contentType = detectDocumentFile(input.file);
  if (!contentType) throw validationFailed("Upload the document as a PDF, JPEG, PNG or WebP file.");

  const [{ n }] = await db
    .select({ n: count() })
    .from(sellerDocumentUploads)
    .where(and(eq(sellerDocumentUploads.shopId, shop.id), gte(sellerDocumentUploads.createdAt, new Date(Date.now() - 3_600_000))));
  if (Number(n) >= rule.maxUploadsPerShopPerHour) {
    throw new AppError("RATE_LIMITED", "Too many uploads for this shop in the last hour. Please try again later.");
  }

  const read = await readDocument(input.file, contentType, auto ? null : (input.docType as UploadDocType), input.browserRead);
  let docType: UploadDocType;
  if (auto) {
    const detected = read.fields?.detectedType ?? detectUploadType(read.text);
    if (!detected) {
      // Nothing stored: the owner picks the document's card and uploads it there.
      throw validationFailed(
        read.readerFailed
          ? "We couldn't read this document just now. Upload it on its card below and type the details."
          : "We couldn't tell which document this is. Take a clearer photo with the heading showing, or upload it on its card below (use Other licence if it isn't listed).",
        { undetected: true },
      );
    }
    docType = detected;
  } else {
    docType = input.docType as UploadDocType;
  }
  const parsed = extractDocumentFields(read.text, docType);
  // An engine that understands documents (Claude) fills what the text parse missed.
  const fields: ExtractedFields = { ...parsed.fields };
  if (read.fields) {
    for (const key of Object.keys(read.fields) as (keyof ExtractedFields)[]) {
      const value = read.fields[key];
      if (value) (fields as unknown as Record<string, unknown>)[key] = value;
    }
  }
  // Never keep an Aadhaar number, whichever engine found it.
  if (fields.number && looksLikeAadhaar(fields.number)) fields.number = null;

  const verificationRule = await getRule("sellerVerification");
  const flags = read.readerFailed
    ? [{ ...NOT_READ_FLAG }]
    : assessExtraction({
    expectedType: docType,
    fields,
    ocrConfidence: read.confidence,
    textLength: read.engine === "claude" && fields.number ? Math.max(parsed.textLength, 25) : parsed.textLength,
    aadhaarRemoved: parsed.aadhaarRemoved,
    shopNames: [shop.ownerName, shop.legalBusinessName, shop.name, shop.gstTradeName],
    today: istToday(),
    expiryWarningDays: verificationRule.expiryWarningDays,
    nameMatchMin: rule.nameMatchWarnBelow,
    imageMinSide: read.imageMinSide,
  });
  if (read.note === "pdf without text layer") {
    const unreadable = flags.find((f) => f.code === "UNREADABLE");
    if (unreadable) {
      unreadable.message =
        "This PDF is a scanned picture, so we can't read it. Take a photo of the document instead, or upload a JPEG/PNG of it.";
    }
  }

  const [row] = await db
    .insert(sellerDocumentUploads)
    .values({
      shopId: shop.id,
      docType,
      source: input.source === "CAMERA" ? "CAMERA" : "FILE",
      contentType,
      sizeBytes: input.file.length,
      sha256: createHash("sha256").update(input.file).digest("hex"),
      dataEncrypted: encryptBytes(input.file),
      readerEngine: read.engine,
      readerConfidence: read.confidence,
      extractedEncrypted: encryptSecret(JSON.stringify(fields)),
      detectedType: fields.detectedType,
      flags,
      blocking: flags.some((f) => f.severity === "block"),
      validUntil: fields.validUntil,
      uploadedBy: input.actor.id,
    })
    .returning();
  await recordAudit({
    actorId: input.actor.id,
    actorRole: input.actor.role,
    action: AUDIT_ACTIONS.SELLER_DOCUMENT_UPLOAD_READ,
    entityType: "seller_document_upload",
    entityId: row.id,
    // Codes only: no number, name or address goes into the audit log.
    newValue: { shopId: shop.id, docType, autoDetected: auto, engine: read.engine, confidence: read.confidence, flags: flags.map((f) => f.code) },
  });
  return toUploadView(row);
}

/* ============================================================== confirm */

export interface ConfirmUploadInput {
  shopId: string;
  uploadId: string;
  fields: ConfirmedFields & { issuingCouncil?: string | null; licenceName?: string | null };
  consentGiven: boolean;
  actor: Actor;
  ipAddress?: string | null;
}

/** Flags that a correction cannot fix — the document itself has to be uploaded again. */
const REUPLOAD_CODES = new Set(["UNREADABLE", "WRONG_DOCUMENT"]);

function correctedFields(read: ExtractedFields | null, confirmed: ConfirmedFields): string[] {
  const norm = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim().toUpperCase();
  const changed: string[] = [];
  const pairs: [string, string | null | undefined, string | null | undefined][] = [
    ["number", read?.number, confirmed.number],
    ["name", read?.name, confirmed.name],
    ["address", read?.address, confirmed.address],
    ["validFrom", read?.validFrom, confirmed.validFrom],
    ["validUntil", read?.validUntil, confirmed.validUntil],
  ];
  for (const [key, a, b] of pairs) {
    const na = norm(a);
    const nb = norm(b);
    if (key === "number" ? na.replace(/[^A-Z0-9]/g, "") !== nb.replace(/[^A-Z0-9]/g, "") : na !== nb) {
      if (na || nb) changed.push(key);
    }
  }
  return changed;
}

export async function confirmUploadedDocument(input: ConfirmUploadInput): Promise<UploadView> {
  const shop = await loadShopFor(input.shopId, input.actor);
  if (!input.consentGiven) throw validationFailed("Please agree to the verification consent before we check this document.");

  // Claim the upload, so a double click submits it once.
  const [claimed] = await db
    .update(sellerDocumentUploads)
    .set({ confirmedBy: input.actor.id, updatedAt: new Date() })
    .where(
      and(
        eq(sellerDocumentUploads.id, input.uploadId),
        eq(sellerDocumentUploads.shopId, shop.id),
        eq(sellerDocumentUploads.status, "EXTRACTED"),
        isNull(sellerDocumentUploads.confirmedBy),
      ),
    )
    .returning();
  if (!claimed) {
    const [existing] = await db.select().from(sellerDocumentUploads).where(eq(sellerDocumentUploads.id, input.uploadId));
    if (!existing || existing.shopId !== shop.id) throw notFound("Upload");
    if (existing.status === "CONFIRMED") return toUploadView(existing);
    throw conflict("This upload is already being submitted, or was discarded. Upload the document again if needed.");
  }
  const release = () =>
    db.update(sellerDocumentUploads).set({ confirmedBy: null, updatedAt: new Date() }).where(eq(sellerDocumentUploads.id, claimed.id));

  try {
    const docType = claimed.docType;
    const flags = claimed.flags as ExtractionFlag[];
    const reupload = flags.find((f) => f.severity === "block" && REUPLOAD_CODES.has(f.code));
    if (reupload) throw validationFailed(reupload.message, { reupload: true, flag: reupload.code });

    const fields: ConfirmedFields & { issuingCouncil?: string | null; licenceName?: string | null } = {
      number: (input.fields.number ?? "").trim(),
      name: input.fields.name?.trim() || null,
      address: input.fields.address?.trim() || null,
      validFrom: input.fields.validFrom || null,
      validUntil: input.fields.validUntil || null,
      issuingCouncil: input.fields.issuingCouncil?.trim() || null,
      licenceName: input.fields.licenceName?.trim() || null,
    };
    const today = istToday();
    const errors = validateConfirmedFields(docType, fields, today);
    if (docType === "MEDICAL_REGISTRATION" && (!fields.issuingCouncil || fields.issuingCouncil.length < 3)) {
      errors.issuingCouncil = "Enter the council that issued the registration.";
    }
    if (Object.keys(errors).length > 0) {
      const expired = Boolean(errors.validUntil && fields.validUntil && fields.validUntil < today);
      throw validationFailed(Object.values(errors)[0], { fields: errors, reupload: expired });
    }

    const read = decryptJson<ExtractedFields>(claimed.extractedEncrypted);
    const corrected = correctedFields(read, fields);
    const file = claimed.dataEncrypted ? decryptBytes(claimed.dataEncrypted) : null;
    if (!file) throw conflict("The uploaded file is no longer available. Upload the document again.");
    const ip = input.ipAddress ?? null;
    const number = checkDocNumber(docType, fields.number);
    const normalized = number.ok ? number.normalized : fields.number;

    let verificationId: string | null = null;
    let legalDocumentId: string | null = null;

    // 1. Seller verification (vendor check, admin review) — the existing pipeline.
    if (isSellerDocType(docType)) {
      const view =
        docType === "SHOP_ACT"
          ? await uploadShopActCertificate({ shopId: shop.id, number: normalized, file, consentGiven: true, actor: input.actor, ipAddress: ip })
          : await submitSellerDocument({ shopId: shop.id, docType, number: normalized, consentGiven: true, actor: input.actor, ipAddress: ip });
      verificationId = view.id;
      if (verificationId && docType !== "SHOP_ACT") {
        await db.insert(sellerVerificationFiles).values({
          verificationId,
          shopId: shop.id,
          contentType: claimed.contentType,
          sizeBytes: file.length,
          sha256: claimed.sha256,
          dataEncrypted: encryptBytes(file),
          uploadedBy: input.actor.id,
        });
      }
    }
    // 2. Legal-documents register (FSSAI, drug licence, medical registration, the optional licences).
    if (docType === "FSSAI" || docType === "DRUG_LICENCE" || docType === "MEDICAL_REGISTRATION" || isAdditionalLicence(docType)) {
      const legal = await submitLegalDocument({
        shopId: shop.id,
        docType,
        number: normalized,
        expiryDate: fields.validUntil,
        issuingCouncil: fields.issuingCouncil,
        licenceName: fields.licenceName,
        file,
        actor: input.actor,
      });
      legalDocumentId = legal.id;
    }

    const last4 = normalized.replace(/[^A-Za-z0-9]/g, "").slice(-4) || null;
    const [updated] = await db
      .update(sellerDocumentUploads)
      .set({
        status: "CONFIRMED",
        confirmedEncrypted: encryptSecret(JSON.stringify(fields)),
        numberLast4: last4,
        validUntil: fields.validUntil,
        fieldsCorrected: corrected,
        verificationId,
        legalDocumentId,
        // The file now lives in the verification / legal-document file table.
        dataEncrypted: null,
        confirmedBy: input.actor.id,
        confirmedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sellerDocumentUploads.id, claimed.id))
      .returning();
    await recordAudit({
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: AUDIT_ACTIONS.SELLER_DOCUMENT_UPLOAD_CONFIRMED,
      entityType: "seller_document_upload",
      entityId: claimed.id,
      newValue: { shopId: shop.id, docType, numberLast4: last4, validUntil: fields.validUntil, fieldsCorrected: corrected, flags: flags.map((f) => f.code) },
    });
    return toUploadView(updated);
  } catch (error) {
    await release();
    throw error;
  }
}

export async function discardUpload(shopId: string, uploadId: string, actor: Actor): Promise<void> {
  const shop = await loadShopFor(shopId, actor);
  await db
    .update(sellerDocumentUploads)
    .set({ status: "DISCARDED", dataEncrypted: null, extractedEncrypted: null, updatedAt: new Date() })
    .where(and(eq(sellerDocumentUploads.id, uploadId), eq(sellerDocumentUploads.shopId, shop.id), eq(sellerDocumentUploads.status, "EXTRACTED")));
}

/** The uploaded file (before confirm), for its owner or a reviewer. Reviewer views are audited. */
export async function getUploadFile(uploadId: string, actor: Actor): Promise<{ contentType: string; data: Buffer }> {
  const [row] = await db.select().from(sellerDocumentUploads).where(eq(sellerDocumentUploads.id, uploadId));
  if (!row) throw notFound("Upload");
  const shop = await loadShopFor(row.shopId, actor);
  if (!row.dataEncrypted) throw notFound("File");
  if (shop.ownerId !== actor.id) {
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SELLER_DOCUMENT_FILE_VIEWED,
      entityType: "seller_document_upload",
      entityId: row.id,
      newValue: { shopId: row.shopId },
    });
  }
  return { contentType: row.contentType, data: decryptBytes(row.dataEncrypted) };
}

/* ================================================================ admin */

export interface ReviewUpload extends UploadView {
  shopId: string;
  shopName: string;
  ownerName: string;
}

/** Recent uploads for admins and operators: what was read, what the owner confirmed, what changed. */
export async function listUploadsForReview(
  actor: Actor,
  options: { flaggedOnly?: boolean; limit?: number } = {},
): Promise<ReviewUpload[]> {
  if (!isReviewer(actor)) throw forbidden("You can't review seller documents.");
  const rows = await db
    .select({ upload: sellerDocumentUploads, shopName: shops.name, ownerName: shops.ownerName })
    .from(sellerDocumentUploads)
    .innerJoin(shops, eq(shops.id, sellerDocumentUploads.shopId))
    .where(
      and(
        inArray(sellerDocumentUploads.status, ["EXTRACTED", "CONFIRMED"]),
        options.flaggedOnly
          ? or(sql`jsonb_array_length(${sellerDocumentUploads.flags}) > 0`, sql`cardinality(${sellerDocumentUploads.fieldsCorrected}) > 0`)
          : undefined,
      ),
    )
    .orderBy(desc(sellerDocumentUploads.createdAt))
    .limit(Math.min(options.limit ?? 100, 500));
  return rows.map((r) => ({ ...toUploadView(r.upload), shopId: r.upload.shopId, shopName: r.shopName, ownerName: r.ownerName }));
}

/** Unconfirmed uploads older than the retention period lose their file and read fields (DPDP: keep only what is needed). */
export async function purgeStaleUploads(now = new Date()): Promise<number> {
  const rule = await getRule("documentUpload");
  const cutoff = new Date(now.getTime() - rule.draftRetentionDays * 86_400_000);
  const purged = await db
    .update(sellerDocumentUploads)
    .set({ status: "DISCARDED", dataEncrypted: null, extractedEncrypted: null, updatedAt: now })
    .where(and(eq(sellerDocumentUploads.status, "EXTRACTED"), sql`${sellerDocumentUploads.createdAt} < ${cutoff}`))
    .returning({ id: sellerDocumentUploads.id });
  return purged.length;
}

/* ================================================================ FSSAI (Task 3) */

export interface FssaiStatus {
  /** A licence on file that has not expired: verified, submitted or under review. */
  onFile: boolean;
  validUntil: string | null;
  expired: boolean;
}

/**
 * Is there an FSSAI licence on file that has not expired? Any one of: the
 * seller-verification FSSAI row (verified or awaiting a check/review), the
 * legal-documents FSSAI (submitted or approved), or a confirmed upload —
 * each with an expiry date today or later (a vendor-verified licence with no
 * date counts; the daily job expires it when the vendor reports a date).
 */
export async function fssaiStatus(shop: Pick<Shop, "id">, client: DbClient = db): Promise<FssaiStatus> {
  const today = istToday();
  const [verification] = await client
    .select({ status: sellerVerifications.status, validUntil: sellerVerifications.validUntil, hasNumber: sql<boolean>`${sellerVerifications.numberEncrypted} IS NOT NULL` })
    .from(sellerVerifications)
    .where(and(eq(sellerVerifications.shopId, shop.id), eq(sellerVerifications.docType, "FSSAI")));
  const [legal] = await client
    .select({ status: shopLegalDocuments.status, expiryDate: shopLegalDocuments.expiryDate })
    .from(shopLegalDocuments)
    .where(and(eq(shopLegalDocuments.shopId, shop.id), eq(shopLegalDocuments.docType, "FSSAI")));
  const [upload] = await client
    .select({ validUntil: sellerDocumentUploads.validUntil })
    .from(sellerDocumentUploads)
    .where(and(eq(sellerDocumentUploads.shopId, shop.id), eq(sellerDocumentUploads.docType, "FSSAI"), eq(sellerDocumentUploads.status, "CONFIRMED")))
    .orderBy(desc(sellerDocumentUploads.confirmedAt))
    .limit(1);

  const dates = [verification?.validUntil, legal?.expiryDate, upload?.validUntil].filter((d): d is string => Boolean(d));
  const latest = dates.sort().at(-1) ?? null;
  const verificationOk =
    verification &&
    verification.hasNumber &&
    SELLER_DONE.has(verification.status) &&
    (verification.validUntil ? verification.validUntil >= today : verification.status === "VERIFIED" || Boolean(upload?.validUntil && upload.validUntil >= today));
  const legalOk = legal && LEGAL_DONE.has(legal.status) && Boolean(legal.expiryDate && legal.expiryDate >= today);
  const onFile = Boolean(verificationOk || legalOk);
  return { onFile, validUntil: latest, expired: !onFile && dates.length > 0 && dates.every((d) => d < today) };
}

export const FSSAI_REQUIRED_MESSAGE =
  "A shop that sells food needs a valid FSSAI licence or registration before registration can be completed. Upload it on Documents (Shop → Upload your documents).";

/** Task 3: food shops cannot complete registration (approval / profile completion) without a valid FSSAI licence. */
export async function fssaiBlocksRegistration(shop: Pick<Shop, "id" | "shopType">, client: DbClient = db): Promise<string | null> {
  const rule = await getRule("documentUpload");
  if (!rule.fssaiMandatoryForFood) return null;
  if (!(await shopSellsFood(shop))) return null;
  const status = await fssaiStatus(shop, client);
  if (status.onFile) return null;
  return status.expired
    ? `This shop's FSSAI licence expired on ${status.validUntil}. Upload the renewed licence before registration can be completed.`
    : FSSAI_REQUIRED_MESSAGE;
}

/** Shop approval gate (shops.ts). Pass the approval's transaction. */
export async function assertFssaiAllowsApproval(shop: Shop, client: DbClient = db): Promise<void> {
  const blocker = await fssaiBlocksRegistration(shop, client);
  if (blocker) throw conflict(blocker, { fssaiRequired: true });
}
