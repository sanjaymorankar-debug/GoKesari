/**
 * Seller document verification (PAN, GSTIN, Udyam, FSSAI, Shop Act).
 *
 * One check, whoever starts it (seller, admin re-check, or the scheduled job):
 *
 *   1. local format check (lib/kyc/doc-formats.ts) — a typo never costs a paid call;
 *   2. ownership + explicit consent (DPDP Act 2023), both recorded;
 *   3. claim the row under a lock: a verified, unexpired number is served
 *      from the stored result, an identical check in flight is joined, and a
 *      shop is held to a per-hour limit of paid checks;
 *   4. the vendor call (src/server/kyc), outside any transaction;
 *   5. the document rules and cross-document consistency score
 *      (seller-verification-checks.ts) decide VERIFIED or MANUAL_REVIEW;
 *   6. result, history event, write-through to the shop's public seller
 *      details (GSTIN, FSSAI number), and a notification to the seller.
 *
 * Full numbers exist only in memory during a check and as ciphertext at rest.
 * Views, events and logs carry the masked form only.
 */
import { and, asc, count, eq, gte, inArray, isNotNull, like, lt, or, sql } from "drizzle-orm";

import { GST_DECLARATION_VERSION, parseGstEnrolmentNumber, SELLER_VERIFICATION_CONSENT_VERSION } from "@/lib/kyc/consent";
import {
  parseSellerDocNumber,
  SELLER_DOC_LABELS,
  SELLER_DOC_TYPES,
  type ParsedDocNumber,
  type SellerDocType,
  type SellerVerificationStatus,
} from "@/lib/kyc/doc-formats";
import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { decryptBytes, decryptSecret, docBlindIndex, encryptBytes, encryptSecret } from "@/lib/pan-crypto";
import { FOOD_SHOP_TYPE_KEYS, isFoodBusinessShopType } from "@/lib/shop-types";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import {
  productCategories,
  sellerVerificationEvents,
  sellerVerificationFiles,
  sellerVerifications,
  shopProductCategories,
  shops,
  type SellerVerification,
  type SellerVerificationFile,
  type Shop,
  type UserRole,
} from "@/server/db/schema";
import { verifyDocument, type SourceRecord, type VerifyExtraFields } from "@/server/kyc";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { detectImage } from "./image-store";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import {
  applyDocumentChecks,
  consistencyScore,
  requirementFor,
  type ConsistencyScore,
  type Requirement,
  type ScoredDoc,
  type ShopFacts,
} from "./seller-verification-checks";
import { getRule } from "./settings";

export { SELLER_VERIFICATION_CONSENT_VERSION };

export interface Actor {
  id: string;
  role: UserRole;
}

/** A second identical submission within this window rides on the first instead of paying again. */
const IN_FLIGHT_WINDOW_MS = 30_000;
const MAX_FILE_BYTES = 5_000_000;

/* ------------------------------------------------------------------ views */

export interface SellerVerificationView {
  id: string | null;
  docType: SellerDocType;
  status: SellerVerificationStatus;
  numberMasked: string | null;
  verifiedName: string | null;
  nameMatchScore: number | null;
  validUntil: string | null;
  providerId: string | null;
  providerRef: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
  details: Record<string, unknown>;
  submittedAt: Date | null;
  verifiedAt: Date | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
}

/** What callers and APIs get — never the ciphertext or blind indexes. */
export function toView(row: SellerVerification): SellerVerificationView {
  const details = { ...((row.details ?? {}) as Record<string, unknown>) };
  delete details.embeddedPanHash;
  return {
    id: row.id,
    docType: row.docType,
    status: row.status,
    numberMasked: row.numberMasked,
    verifiedName: row.verifiedName,
    nameMatchScore: row.nameMatchScore,
    validUntil: row.validUntil,
    providerId: row.providerId,
    providerRef: row.providerRef,
    attemptCount: row.attemptCount,
    lastErrorCode: row.lastErrorCode,
    details,
    submittedAt: row.submittedAt,
    verifiedAt: row.verifiedAt,
    reviewedAt: row.reviewedAt,
    reviewNote: row.reviewNote,
  };
}

function emptyView(docType: SellerDocType): SellerVerificationView {
  return {
    id: null,
    docType,
    status: "NOT_SUBMITTED",
    numberMasked: null,
    verifiedName: null,
    nameMatchScore: null,
    validUntil: null,
    providerId: null,
    providerRef: null,
    attemptCount: 0,
    lastErrorCode: null,
    details: {},
    submittedAt: null,
    verifiedAt: null,
    reviewedAt: null,
    reviewNote: null,
  };
}

/* ---------------------------------------------------------------- helpers */

function isReviewer(actor: Actor): boolean {
  return can(actor.role, PERMISSIONS.SHOP_GST_PAN_VERIFY);
}

async function loadShopFor(shopId: string, actor: Actor): Promise<Shop> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop || shop.deletedAt) throw notFound("Shop");
  if (shop.ownerId !== actor.id && !isReviewer(actor)) throw forbidden("This shop does not belong to you.");
  return shop;
}

/**
 * Two-letter state for state-specific lookups (Shop Act) and the GSTIN state
 * check. Shops store a PIN code but no state; PIN codes 40xxxx–44xxxx are
 * Maharashtra. Elsewhere the state is unknown and the state check is skipped.
 */
export function stateCodeForPincode(pincode: string | null | undefined): string | undefined {
  const prefix = Number((pincode ?? "").slice(0, 2));
  return prefix >= 40 && prefix <= 44 ? "MH" : undefined;
}

/** A shop sells food if its type is a food business or any category it carries is in a food aisle. */
export async function shopSellsFood(shop: Pick<Shop, "id" | "shopType">): Promise<boolean> {
  if (isFoodBusinessShopType(shop.shopType)) return true;
  const [row] = await db
    .select({ n: count() })
    .from(shopProductCategories)
    .innerJoin(productCategories, eq(productCategories.id, shopProductCategories.categoryId))
    .where(
      and(
        eq(shopProductCategories.shopId, shop.id),
        inArray(productCategories.department, FOOD_SHOP_TYPE_KEYS as (typeof FOOD_SHOP_TYPE_KEYS)[number][]),
      ),
    );
  return (row?.n ?? 0) > 0;
}

export async function shopFacts(shop: Shop): Promise<ShopFacts> {
  return {
    ownerName: shop.ownerName,
    legalBusinessName: shop.legalBusinessName,
    shopName: shop.name,
    pincode: shop.pincode,
    stateCode: stateCodeForPincode(shop.pincode),
    isFoodBusiness: await shopSellsFood(shop),
  };
}

type EventInsert = typeof sellerVerificationEvents.$inferInsert;

async function recordEvent(client: DbClient, event: EventInsert): Promise<void> {
  await client.insert(sellerVerificationEvents).values(event);
}

function actorFields(actor: Actor | null, ip: string | null) {
  return { actorId: actor?.id ?? null, actorRole: actor?.role ?? null, ipAddress: ip };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------ claim a row */

interface ClaimInput {
  shopId: string;
  docType: SellerDocType;
  doc: ParsedDocNumber;
  actor: Actor | null;
  ip: string | null;
  /** A fresh consent from the seller; null for a re-check under the consent already on file. */
  consentVersion: string | null;
  /** Admin re-check / scheduled re-check: always call the vendor. */
  force: boolean;
}

type Claim =
  | { kind: "done"; row: SellerVerification }
  | { kind: "call"; row: SellerVerification; idempotencyKey: string; previousStatus: SellerVerificationStatus };

async function claimCheck(input: ClaimInput): Promise<Claim> {
  const { shopId, docType, doc, actor, ip } = input;
  const numberHash = docBlindIndex(docType, doc.normalized);
  const now = new Date();
  const rule = await getRule("sellerVerification");

  return db.transaction(async (tx) => {
    await tx
      .insert(sellerVerifications)
      .values({ shopId, docType })
      .onConflictDoNothing({ target: [sellerVerifications.shopId, sellerVerifications.docType] });
    const [row] = await tx
      .select()
      .from(sellerVerifications)
      .where(and(eq(sellerVerifications.shopId, shopId), eq(sellerVerifications.docType, docType)))
      .for("update");

    const sameNumber = row.numberHash === numberHash;
    const base = { verificationId: row.id, shopId, docType, ...actorFields(actor, ip) };

    if (!input.force && sameNumber && row.status === "VERIFIED" && (!row.validUntil || row.validUntil >= today())) {
      await recordEvent(tx, { ...base, eventType: "CACHE_HIT", fromStatus: row.status, toStatus: row.status });
      return { kind: "done" as const, row };
    }
    if (
      sameNumber &&
      row.status === "PENDING" &&
      row.lastAttemptAt &&
      now.getTime() - row.lastAttemptAt.getTime() < IN_FLIGHT_WINDOW_MS
    ) {
      return { kind: "done" as const, row };
    }

    // Per-shop limit on paid checks a person can trigger (scheduled re-checks are not counted).
    if (actor) {
      const [{ n }] = await tx
        .select({ n: count() })
        .from(sellerVerificationEvents)
        .where(
          and(
            eq(sellerVerificationEvents.shopId, shopId),
            eq(sellerVerificationEvents.eventType, "SUBMITTED"),
            isNotNull(sellerVerificationEvents.actorId),
            gte(sellerVerificationEvents.createdAt, new Date(now.getTime() - 3_600_000)),
          ),
        );
      if (n >= rule.maxChecksPerShopPerHour) {
        throw new AppError("RATE_LIMITED", "Too many document checks for this shop in the last hour. Please try again later.");
      }
    }

    const attempt = row.attemptCount + 1;
    const idempotencyKey = `${row.id}:${attempt}`;
    const [claimed] = await tx
      .update(sellerVerifications)
      .set({
        status: "PENDING",
        numberEncrypted: encryptSecret(doc.normalized),
        numberMasked: doc.masked,
        numberHash,
        // A new number invalidates everything learned about the old one.
        ...(sameNumber
          ? {}
          : { verifiedName: null, nameMatchScore: null, details: {}, validUntil: null, verifiedAt: null, reviewNote: null }),
        attemptCount: attempt,
        lastAttemptAt: now,
        lastErrorCode: null,
        idempotencyKey,
        ...(input.consentVersion
          ? { consentGivenAt: now, consentVersion: input.consentVersion, submittedBy: actor?.id ?? null, submittedAt: now }
          : {}),
        updatedAt: now,
      })
      .where(eq(sellerVerifications.id, row.id))
      .returning();

    if (input.consentVersion) {
      await recordEvent(tx, {
        ...base,
        eventType: "CONSENT_GIVEN",
        note: `Consent notice ${input.consentVersion}`,
        details: { purpose: "seller_document_verification", numberMasked: doc.masked },
      });
    }
    await recordEvent(tx, {
      ...base,
      eventType: input.consentVersion ? "SUBMITTED" : "RECHECK_REQUESTED",
      fromStatus: row.status,
      toStatus: "PENDING",
      details: { numberMasked: doc.masked, attempt },
    });
    return { kind: "call" as const, row: claimed, idempotencyKey, previousStatus: row.status };
  });
}

/* --------------------------------------------------- run the vendor check */

function recordDetails(record: SourceRecord | null): Record<string, unknown> {
  if (!record) return {};
  return {
    docStatus: record.docStatus,
    recordName: record.name ?? null,
    tradeName: record.tradeName ?? null,
    ownerName: record.ownerName ?? null,
    entityType: record.entityType ?? null,
    stateCode: record.stateCode ?? null,
    pincode: record.pincode ?? null,
    address: record.address ?? null,
    category: record.category ?? null,
    vendorNameMatchScore: record.vendorNameMatchScore ?? null,
  };
}

async function runCheck(
  claim: Extract<Claim, { kind: "call" }>,
  shop: Shop,
  doc: ParsedDocNumber,
  actor: Actor | null,
  ip: string | null,
  extra: VerifyExtraFields = {},
): Promise<SellerVerification> {
  const docType = doc.docType;
  const facts = await shopFacts(shop);
  const rule = await getRule("sellerVerification");

  const result = await verifyDocument(
    docType,
    doc.normalized,
    {
      nameToMatch: shop.legalBusinessName ?? shop.ownerName ?? shop.name,
      stateCode: facts.stateCode,
      city: shop.city ?? undefined,
      ...extra,
    },
    claim.idempotencyKey,
  );

  // GSTIN ↔ PAN: compare blind indexes, never decrypted numbers.
  const siblings = await db.select().from(sellerVerifications).where(eq(sellerVerifications.shopId, shop.id));
  let gstinPanMatchesShopPan: boolean | null = null;
  let embeddedPanHash: string | null = null;
  if (docType === "GSTIN" && doc.gstEmbeddedPan) {
    embeddedPanHash = docBlindIndex("PAN", doc.gstEmbeddedPan);
    const pan = siblings.find((s) => s.docType === "PAN" && s.numberHash);
    if (pan) gstinPanMatchesShopPan = pan.numberHash === embeddedPanHash;
  }

  const checked = applyDocumentChecks({
    docType,
    vendorStatus: result.status,
    record: result.record,
    shop: facts,
    gstinPanMatchesShopPan,
    gstStateCode: doc.gstStateCode,
    nameMatchAutoApprove: rule.nameMatchAutoApprove,
  });

  let status = checked.status;
  let errorCode = checked.errorCode ?? result.errorCode;
  const details: Record<string, unknown> = {
    ...recordDetails(result.record),
    panLinked: checked.checks.panLinked,
    stateMatch: checked.checks.stateMatch,
    pincodeMatch: checked.checks.pincodeMatch,
    matchedShopName: checked.checks.matchedShopName,
    ...(embeddedPanHash ? { embeddedPanHash } : {}),
  };

  // Cross-document consistency: verify without a person only above the threshold.
  let consistency: ConsistencyScore | null = null;
  if (status === "VERIFIED") {
    const scored: ScoredDoc[] = siblings
      .filter((s) => s.docType !== docType)
      .map((s) => ({ docType: s.docType, status: s.status, nameMatchScore: s.nameMatchScore, details: s.details as ScoredDoc["details"] }));
    scored.push({ docType, status, nameMatchScore: checked.checks.nameScore, details });
    consistency = consistencyScore(scored);
    if (consistency.score !== null && consistency.score < rule.consistencyAutoApprove) {
      status = "MANUAL_REVIEW";
      errorCode = "consistency_below_threshold";
    }
  }
  if (consistency) details.consistencyScore = consistency.score;

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(sellerVerifications)
      .set({
        status,
        verifiedName: result.matchedName,
        nameMatchScore: checked.checks.nameScore,
        validUntil: result.validUntil,
        details,
        providerId: result.providerId,
        providerRef: result.rawRef,
        lastErrorCode: errorCode,
        verifiedAt: status === "VERIFIED" ? new Date() : null,
        reviewerId: null,
        reviewedAt: null,
        updatedAt: new Date(),
      })
      // Only if no newer check claimed the row while the vendor was answering.
      .where(and(eq(sellerVerifications.id, claim.row.id), eq(sellerVerifications.idempotencyKey, claim.idempotencyKey)))
      .returning();
    if (!row) return null;

    const base = { verificationId: row.id, shopId: shop.id, docType, ...actorFields(actor, ip) };
    await recordEvent(tx, {
      ...base,
      eventType: "VENDOR_RESULT",
      fromStatus: "PENDING",
      toStatus: result.status,
      providerId: result.providerId,
      providerRef: result.rawRef,
      errorCode: result.errorCode,
      details: { numberMasked: doc.masked, docStatus: result.record?.docStatus ?? null },
    });
    if (status !== result.status) {
      await recordEvent(tx, {
        ...base,
        eventType: "CHECKS_APPLIED",
        fromStatus: result.status,
        toStatus: status,
        errorCode,
        details: { nameScore: checked.checks.nameScore, consistencyScore: consistency?.score ?? null },
      });
    }
    await writeThrough(tx, shop.id, docType, status, doc.normalized, result.record, null);
    return row;
  });

  if (!updated) {
    const latest = await db.query.sellerVerifications.findFirst({ where: eq(sellerVerifications.id, claim.row.id) });
    return latest ?? claim.row;
  }
  if (status !== claim.previousStatus) await notifyOwner(shop, updated);
  return updated;
}

/**
 * Keeps the seller details buyers see (Consumer Protection (E-Commerce)
 * Rules 2020) in step with what was verified: GSTIN, legal name, FSSAI number.
 */
async function writeThrough(
  tx: DbClient,
  shopId: string,
  docType: SellerDocType,
  status: SellerVerificationStatus,
  normalized: string | null,
  record: SourceRecord | null,
  reviewerId: string | null,
): Promise<void> {
  const now = new Date();
  if (docType === "GSTIN" && status === "VERIFIED" && normalized) {
    await tx
      .update(shops)
      .set({
        gstin: normalized,
        gstStatus: "REGISTERED",
        gstTradeName: record?.tradeName ?? sql`${shops.gstTradeName}`,
        legalBusinessName: record?.name ? sql`COALESCE(${shops.legalBusinessName}, ${record.name})` : sql`${shops.legalBusinessName}`,
        gstVerificationSource: reviewerId ? "ADMIN_VERIFIED" : "PROVIDER_VERIFIED",
        gstVerifiedAt: now,
        gstVerifiedBy: reviewerId,
        updatedAt: now,
      })
      .where(eq(shops.id, shopId));
  } else if (docType === "GSTIN" && (status === "FAILED" || status === "EXPIRED") && normalized) {
    await tx
      .update(shops)
      .set({ gstStatus: "VERIFICATION_FAILED", updatedAt: now })
      .where(and(eq(shops.id, shopId), eq(shops.gstin, normalized)));
  } else if (docType === "FSSAI" && status === "VERIFIED" && normalized) {
    await tx.update(shops).set({ fssaiLicenseNumber: normalized, updatedAt: now }).where(eq(shops.id, shopId));
  }
}

const ATTENTION_TEXT: Record<string, string> = {
  not_found_at_source: "The number was not found in the government record. Please check it and submit again.",
  document_expired: "The document has expired. Please renew it and submit the new one.",
  document_cancelled: "The government record shows this document as cancelled.",
  document_inactive: "The government record shows this document as inactive.",
  document_suspended: "The government record shows this document as suspended.",
};

async function notifyOwner(shop: Shop, row: SellerVerification): Promise<void> {
  const label = SELLER_DOC_LABELS[row.docType];
  if (row.status === "VERIFIED") {
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.SHOP_DOCUMENT_VERIFIED,
      title: `${label} verified`,
      body: `${shop.name}'s ${label} (${row.numberMasked ?? "on file"}) has been verified.`,
      actionUrl: "/shop/verification",
    });
  } else if (row.status === "FAILED" || row.status === "EXPIRED") {
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.SHOP_DOCUMENT_ATTENTION,
      title: `${label} needs your attention`,
      body: row.reviewNote ?? ATTENTION_TEXT[row.lastErrorCode ?? ""] ?? `We couldn't verify ${shop.name}'s ${label}.`,
      actionUrl: "/shop/verification",
    });
  }
}

/* ------------------------------------------------------ seller submissions */

export interface SubmitDocumentInput {
  shopId: string;
  docType: SellerDocType;
  number: string;
  /** Must be true: the seller ticked the consent box for this check. */
  consentGiven: boolean;
  consentVersion?: string;
  actor: Actor;
  ipAddress?: string | null;
  extra?: VerifyExtraFields;
}

export async function submitSellerDocument(input: SubmitDocumentInput): Promise<SellerVerificationView> {
  const { shopId, docType, actor } = input;
  if (!SELLER_DOC_TYPES.includes(docType)) throw validationFailed("Unknown document type.");
  const parsed = parseSellerDocNumber(docType, input.number);
  if (!parsed.ok) throw validationFailed(parsed.error);
  if (!input.consentGiven) {
    throw validationFailed("Please agree to the verification consent before we check this document.");
  }
  const shop = await loadShopFor(shopId, actor);
  const ip = input.ipAddress ?? null;

  const claim = await claimCheck({
    shopId,
    docType,
    doc: parsed.value,
    actor,
    ip,
    consentVersion: input.consentVersion ?? SELLER_VERIFICATION_CONSENT_VERSION,
    force: false,
  });
  if (claim.kind === "done") return toView(claim.row);
  return toView(await runCheck(claim, shop, parsed.value, actor, ip, input.extra));
}

/**
 * "This shop has no GSTIN": a signed declaration instead of a number, always
 * reviewed by an admin. Clears any GSTIN on file.
 */
export async function declareNoGstin(input: {
  shopId: string;
  declarationAccepted: boolean;
  enrolmentNumber?: string | null;
  actor: Actor;
  ipAddress?: string | null;
}): Promise<SellerVerificationView> {
  if (!input.declarationAccepted) throw validationFailed("Please confirm the declaration.");
  let enrolment: string | null = null;
  if (input.enrolmentNumber?.trim()) {
    const parsed = parseGstEnrolmentNumber(input.enrolmentNumber);
    if (!parsed.ok) throw validationFailed(parsed.error);
    enrolment = parsed.value;
  }
  const shop = await loadShopFor(input.shopId, input.actor);
  const now = new Date();
  const ip = input.ipAddress ?? null;

  const row = await db.transaction(async (tx) => {
    await tx
      .insert(sellerVerifications)
      .values({ shopId: shop.id, docType: "GSTIN" })
      .onConflictDoNothing({ target: [sellerVerifications.shopId, sellerVerifications.docType] });
    const [current] = await tx
      .select()
      .from(sellerVerifications)
      .where(and(eq(sellerVerifications.shopId, shop.id), eq(sellerVerifications.docType, "GSTIN")))
      .for("update");
    const [updated] = await tx
      .update(sellerVerifications)
      .set({
        status: "MANUAL_REVIEW",
        numberEncrypted: null,
        numberMasked: null,
        numberHash: null,
        verifiedName: null,
        nameMatchScore: null,
        validUntil: null,
        providerId: null,
        providerRef: null,
        lastErrorCode: "gst_declaration_review",
        idempotencyKey: null,
        details: { declaredNotRegistered: true, declarationVersion: GST_DECLARATION_VERSION, enrolmentNumber: enrolment },
        consentGivenAt: now,
        consentVersion: GST_DECLARATION_VERSION,
        submittedBy: input.actor.id,
        submittedAt: now,
        verifiedAt: null,
        reviewerId: null,
        reviewedAt: null,
        reviewNote: null,
        updatedAt: now,
      })
      .where(eq(sellerVerifications.id, current.id))
      .returning();
    await recordEvent(tx, {
      verificationId: current.id,
      shopId: shop.id,
      docType: "GSTIN",
      ...actorFields(input.actor, ip),
      eventType: "DECLARED_NOT_APPLICABLE",
      fromStatus: current.status,
      toStatus: "MANUAL_REVIEW",
      note: `GST declaration ${GST_DECLARATION_VERSION}`,
      details: { enrolmentNumberGiven: Boolean(enrolment) },
    });
    await tx
      .update(shops)
      .set({ gstStatus: "NOT_REGISTERED", gstin: null, gstTradeName: null, gstVerificationSource: "SELF_DECLARED", gstVerifiedAt: null, gstVerifiedBy: null, updatedAt: now })
      .where(eq(shops.id, shop.id));
    return updated;
  });
  return toView(row);
}

/** File type from the bytes, never the name or declared type. */
export function detectDocumentFile(data: Buffer): SellerVerificationFile["contentType"] | null {
  if (data.length > 5 && data.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return detectImage(data)?.contentType ?? null;
}

/**
 * Shop Act certificate (or Form G intimation receipt) upload. The vendor is
 * still asked first; where it can't check the number — Maharashtra today —
 * the certificate goes to an admin, who compares it with the number the
 * seller typed. (No OCR: the seller enters the number printed on it.)
 */
export async function uploadShopActCertificate(input: {
  shopId: string;
  number: string;
  file: Buffer;
  consentGiven: boolean;
  actor: Actor;
  ipAddress?: string | null;
}): Promise<SellerVerificationView> {
  if (input.file.length === 0) throw validationFailed("The file is empty.");
  if (input.file.length > MAX_FILE_BYTES) throw validationFailed("The certificate can be at most 5 MB.");
  const contentType = detectDocumentFile(input.file);
  if (!contentType) throw validationFailed("Upload the certificate as a PDF, JPEG, PNG or WebP file.");

  const view = await submitSellerDocument({
    shopId: input.shopId,
    docType: "SHOP_ACT",
    number: input.number,
    consentGiven: input.consentGiven,
    actor: input.actor,
    ipAddress: input.ipAddress,
  });
  const ip = input.ipAddress ?? null;
  const { createHash } = await import("node:crypto");

  const row = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(sellerVerifications)
      .where(and(eq(sellerVerifications.shopId, input.shopId), eq(sellerVerifications.docType, "SHOP_ACT")))
      .for("update");
    await tx.insert(sellerVerificationFiles).values({
      verificationId: current.id,
      shopId: input.shopId,
      contentType,
      sizeBytes: input.file.length,
      sha256: createHash("sha256").update(input.file).digest("hex"),
      dataEncrypted: encryptBytes(input.file),
      uploadedBy: input.actor.id,
    });
    // Not found / can't check → the certificate is the evidence; an admin decides.
    const needsReview =
      current.status === "MANUAL_REVIEW" || (current.status === "FAILED" && current.lastErrorCode === "not_found_at_source");
    const [updated] = needsReview
      ? await tx
          .update(sellerVerifications)
          .set({ status: "MANUAL_REVIEW", lastErrorCode: "certificate_review", updatedAt: new Date() })
          .where(eq(sellerVerifications.id, current.id))
          .returning()
      : [current];
    await recordEvent(tx, {
      verificationId: current.id,
      shopId: input.shopId,
      docType: "SHOP_ACT",
      ...actorFields(input.actor, ip),
      eventType: "FILE_UPLOADED",
      fromStatus: current.status,
      toStatus: updated.status,
      details: { contentType, sizeBytes: input.file.length, numberMasked: view.numberMasked },
    });
    return updated;
  });
  return toView(row);
}

/** An uploaded certificate, for its shop's owner or a reviewer. Reviewer views are audited. */
export async function getVerificationFile(
  fileId: string,
  actor: Actor,
): Promise<{ contentType: string; data: Buffer }> {
  const file = await db.query.sellerVerificationFiles.findFirst({ where: eq(sellerVerificationFiles.id, fileId) });
  if (!file) throw notFound("File");
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, file.shopId), columns: { ownerId: true } });
  const isOwner = shop?.ownerId === actor.id;
  if (!isOwner && !isReviewer(actor)) throw forbidden("You can't open this file.");
  if (!isOwner) {
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SELLER_DOCUMENT_FILE_VIEWED,
      entityType: "seller_verification",
      entityId: file.verificationId,
      newValue: { fileId },
    });
  }
  return { contentType: file.contentType, data: decryptBytes(file.dataEncrypted) };
}

/* ----------------------------------------------------------------- reads */

export async function listShopVerifications(shopId: string, actor: Actor): Promise<SellerVerificationView[]> {
  await loadShopFor(shopId, actor);
  const rows = await db
    .select()
    .from(sellerVerifications)
    .where(eq(sellerVerifications.shopId, shopId))
    .orderBy(asc(sellerVerifications.docType));
  const byType = new Map(rows.map((r) => [r.docType, r]));
  return SELLER_DOC_TYPES.map((t) => {
    const row = byType.get(t);
    return row ? toView(row) : emptyView(t);
  });
}

export interface ShopVerificationSummary {
  documents: (SellerVerificationView & { requirement: Requirement; label: string; files: { id: string; contentType: string; createdAt: Date }[] })[];
  consistency: ConsistencyScore;
  autoApproveScore: number;
  /** Every mandatory document is VERIFIED (a reviewed GST declaration counts for GSTIN). */
  complete: boolean;
  missing: SellerDocType[];
  isFoodBusiness: boolean;
}

export async function getShopVerificationSummary(shopId: string, actor: Actor): Promise<ShopVerificationSummary> {
  const shop = await loadShopFor(shopId, actor);
  const facts = await shopFacts(shop);
  const rule = await getRule("sellerVerification");
  const rows = await db.select().from(sellerVerifications).where(eq(sellerVerifications.shopId, shopId));
  const files = rows.length
    ? await db
        .select({ id: sellerVerificationFiles.id, verificationId: sellerVerificationFiles.verificationId, contentType: sellerVerificationFiles.contentType, createdAt: sellerVerificationFiles.createdAt })
        .from(sellerVerificationFiles)
        .where(eq(sellerVerificationFiles.shopId, shopId))
        .orderBy(asc(sellerVerificationFiles.createdAt))
    : [];

  const byType = new Map(rows.map((r) => [r.docType, r]));
  const documents = SELLER_DOC_TYPES.map((docType) => {
    const row = byType.get(docType);
    return {
      ...(row ? toView(row) : emptyView(docType)),
      requirement: requirementFor(docType, facts),
      label: SELLER_DOC_LABELS[docType],
      files: row ? files.filter((f) => f.verificationId === row.id).map(({ id, contentType, createdAt }) => ({ id, contentType, createdAt })) : [],
    };
  });
  const missing = documents
    .filter((d) => (d.requirement === "required" || d.requirement === "required_or_declaration") && d.status !== "VERIFIED")
    .map((d) => d.docType);
  return {
    documents,
    consistency: consistencyScore(
      rows.map((r) => ({ docType: r.docType, status: r.status, nameMatchScore: r.nameMatchScore, details: r.details as ScoredDoc["details"] })),
    ),
    autoApproveScore: rule.consistencyAutoApprove,
    complete: missing.length === 0,
    missing,
    isFoodBusiness: facts.isFoodBusiness,
  };
}

/* ------------------------------------------------------------------ admin */

export interface ReviewQueueItem {
  view: SellerVerificationView;
  shopId: string;
  shopName: string;
  city: string | null;
  ownerName: string | null;
  legalBusinessName: string | null;
  pincode: string | null;
  files: { id: string; contentType: string }[];
  updatedAt: Date;
}

/** Documents an admin must decide: MANUAL_REVIEW, plus PENDING ones stuck on our configuration. */
export async function listVerificationReviewQueue(actor: Actor): Promise<ReviewQueueItem[]> {
  if (!isReviewer(actor)) throw forbidden("You can't review seller documents.");
  const rows = await db
    .select({ v: sellerVerifications, shop: shops })
    .from(sellerVerifications)
    .innerJoin(shops, eq(shops.id, sellerVerifications.shopId))
    .where(
      and(
        sql`${shops.deletedAt} IS NULL`,
        or(
          eq(sellerVerifications.status, "MANUAL_REVIEW"),
          and(eq(sellerVerifications.status, "PENDING"), like(sellerVerifications.lastErrorCode, "config_%")),
        ),
      ),
    )
    .orderBy(asc(sellerVerifications.updatedAt))
    .limit(200);
  const ids = rows.map((r) => r.v.id);
  const files = ids.length
    ? await db
        .select({ id: sellerVerificationFiles.id, verificationId: sellerVerificationFiles.verificationId, contentType: sellerVerificationFiles.contentType })
        .from(sellerVerificationFiles)
        .where(inArray(sellerVerificationFiles.verificationId, ids))
    : [];
  return rows.map(({ v, shop }) => ({
    view: toView(v),
    shopId: shop.id,
    shopName: shop.name,
    city: shop.city,
    ownerName: shop.ownerName,
    legalBusinessName: shop.legalBusinessName,
    pincode: shop.pincode,
    files: files.filter((f) => f.verificationId === v.id).map(({ id, contentType }) => ({ id, contentType })),
    updatedAt: v.updatedAt,
  }));
}

export async function adminDecideVerification(
  verificationId: string,
  input: { decision: "approve" | "reject"; reason: string },
  actor: Actor,
): Promise<SellerVerificationView> {
  if (!isReviewer(actor)) throw forbidden("You can't review seller documents.");
  const reason = input.reason.trim();
  if (input.decision === "reject" && reason.length < 3) throw validationFailed("A rejection reason is required.");

  const row = await db.query.sellerVerifications.findFirst({ where: eq(sellerVerifications.id, verificationId) });
  if (!row) throw notFound("Verification");
  if (row.status === "NOT_SUBMITTED") throw conflict("Nothing has been submitted for this document yet.");
  const declared = (row.details as Record<string, unknown>)?.declaredNotRegistered === true;
  if (input.decision === "approve" && !row.numberEncrypted && !declared) {
    throw conflict("There is no document number to approve.");
  }
  const toStatus: SellerVerificationStatus = input.decision === "approve" ? "VERIFIED" : "FAILED";
  const now = new Date();

  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(sellerVerifications)
      .set({
        status: toStatus,
        verifiedAt: toStatus === "VERIFIED" ? now : null,
        lastErrorCode: toStatus === "FAILED" ? "rejected_by_admin" : null,
        reviewerId: actor.id,
        reviewedAt: now,
        reviewNote: reason || null,
        updatedAt: now,
      })
      .where(eq(sellerVerifications.id, row.id))
      .returning();
    await recordEvent(tx, {
      verificationId: row.id,
      shopId: row.shopId,
      docType: row.docType,
      ...actorFields(actor, null),
      eventType: input.decision === "approve" ? "ADMIN_APPROVED" : "ADMIN_REJECTED",
      fromStatus: row.status,
      toStatus,
      note: reason || null,
    });
    if (!declared) {
      const normalized = row.numberEncrypted ? decryptSecret(row.numberEncrypted) : null;
      const details = row.details as Record<string, unknown>;
      await writeThrough(
        tx,
        row.shopId,
        row.docType,
        toStatus,
        normalized,
        { docStatus: "active", name: row.verifiedName, tradeName: (details.tradeName as string | null) ?? null },
        actor.id,
      );
    }
    return u;
  });

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: input.decision === "approve" ? AUDIT_ACTIONS.SELLER_DOCUMENT_APPROVED : AUDIT_ACTIONS.SELLER_DOCUMENT_REJECTED,
    entityType: "shop",
    entityId: row.shopId,
    previousValue: { docType: row.docType, status: row.status },
    newValue: { docType: row.docType, status: toStatus, numberMasked: row.numberMasked, reason: reason || null },
  });
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, row.shopId) });
  if (shop) await notifyOwner(shop, updated);
  return toView(updated);
}

/**
 * Asks the vendor again with the number on file — admin "re-check" and the
 * scheduled job (actor null). Runs under the consent already recorded.
 */
export async function recheckVerification(verificationId: string, actor: Actor | null): Promise<SellerVerificationView> {
  if (actor && !isReviewer(actor)) throw forbidden("You can't re-check seller documents.");
  const row = await db.query.sellerVerifications.findFirst({ where: eq(sellerVerifications.id, verificationId) });
  if (!row) throw notFound("Verification");
  if (!row.numberEncrypted) throw conflict("There is no document number on file to re-check.");
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, row.shopId) });
  if (!shop || shop.deletedAt) throw notFound("Shop");

  const parsed = parseSellerDocNumber(row.docType, decryptSecret(row.numberEncrypted));
  if (!parsed.ok) throw conflict("The number on file no longer passes the format check; ask the seller to resubmit.");

  const claim = await claimCheck({
    shopId: row.shopId,
    docType: row.docType,
    doc: parsed.value,
    actor,
    ip: null,
    consentVersion: null,
    force: true,
  });
  if (actor) {
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SELLER_DOCUMENT_RECHECKED,
      entityType: "shop",
      entityId: row.shopId,
      newValue: { docType: row.docType, numberMasked: row.numberMasked },
    });
  }
  if (claim.kind === "done") return toView(claim.row);
  return toView(await runCheck(claim, shop, parsed.value, actor, null));
}

/* --------------------------------------------------- retention & erasure */

/** Shop states in which verification data is no longer needed to keep selling. */
const CLOSED_STATUSES = ["REJECTED", "INACTIVE"] as const;

/**
 * Erases every seller-verification record for a shop — numbers, certificates
 * and history (DPDP Act 2023 s.8(7) / s.12 erasure). Only for a shop that no
 * longer sells: while it is live the documents are what make it lawful to
 * list. `actor` null is the retention job. The audit entry keeps counts only.
 * The vendor's copy is governed by its data processing agreement.
 */
export async function eraseShopVerificationData(
  shopId: string,
  reason: string,
  actor: Actor | null,
): Promise<{ documents: number; files: number; events: number }> {
  if (actor && actor.role !== "ADMIN") throw forbidden("Only an administrator can erase verification data.");
  if (reason.trim().length < 3) throw validationFailed("A reason is required.");
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) throw notFound("Shop");
  const closed = Boolean(shop.deletedAt) || (CLOSED_STATUSES as readonly string[]).includes(shop.status);
  if (!closed) {
    throw conflict("Verification data can only be erased once the shop has stopped selling (rejected, inactive or deleted).");
  }

  const counts = await db.transaction(async (tx) => {
    const [docs] = await tx.select({ n: count() }).from(sellerVerifications).where(eq(sellerVerifications.shopId, shopId));
    const [files] = await tx.select({ n: count() }).from(sellerVerificationFiles).where(eq(sellerVerificationFiles.shopId, shopId));
    const [events] = await tx.select({ n: count() }).from(sellerVerificationEvents).where(eq(sellerVerificationEvents.shopId, shopId));
    // Files and events cascade from their verification row.
    await tx.delete(sellerVerifications).where(eq(sellerVerifications.shopId, shopId));
    await tx.delete(sellerVerificationEvents).where(eq(sellerVerificationEvents.shopId, shopId));
    return { documents: docs.n, files: files.n, events: events.n };
  });

  await recordAudit({
    actorId: actor?.id ?? null,
    actorRole: actor?.role ?? null,
    action: AUDIT_ACTIONS.SELLER_DOCUMENTS_ERASED,
    entityType: "shop",
    entityId: shopId,
    newValue: { ...counts, reason: reason.trim() },
  });
  return counts;
}

/** Shops whose verification data has outlived the retention period after closing. */
export async function shopsDueForVerificationErasure(retentionDays: number, now = new Date(), limit = 100): Promise<string[]> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const rows = await db
    .selectDistinct({ id: shops.id })
    .from(shops)
    .innerJoin(sellerVerifications, eq(sellerVerifications.shopId, shops.id))
    .where(
      or(
        and(isNotNull(shops.deletedAt), lt(shops.deletedAt, cutoff)),
        and(inArray(shops.status, [...CLOSED_STATUSES]), lt(shops.updatedAt, cutoff)),
      ),
    )
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * For the public seller-information page (Consumer Protection (E-Commerce)
 * Rules 2020): which documents were verified against government records,
 * and when. Never a number — the GSTIN and FSSAI number the page shows come
 * from the shop's own public fields.
 */
export async function getPublicVerifiedDocuments(shopId: string): Promise<{ docType: SellerDocType; label: string; verifiedAt: Date | null }[]> {
  const rows = await db
    .select({ docType: sellerVerifications.docType, verifiedAt: sellerVerifications.verifiedAt, details: sellerVerifications.details })
    .from(sellerVerifications)
    .where(and(eq(sellerVerifications.shopId, shopId), eq(sellerVerifications.status, "VERIFIED")));
  return rows
    .filter((r) => (r.details as Record<string, unknown>)?.declaredNotRegistered !== true)
    .sort((a, b) => SELLER_DOC_TYPES.indexOf(a.docType) - SELLER_DOC_TYPES.indexOf(b.docType))
    .map((r) => ({ docType: r.docType, label: SELLER_DOC_LABELS[r.docType], verifiedAt: r.verifiedAt }));
}
