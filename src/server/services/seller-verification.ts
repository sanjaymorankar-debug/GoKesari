/**
 * Seller document verification — the core pipeline (seller verification,
 * Part 2). One submission:
 *
 *   1. local format check (lib/kyc/doc-formats.ts) — a typo never costs a paid call;
 *   2. ownership + explicit consent (DPDP Act 2023), both recorded;
 *   3. cache / double-submit guard — an already-verified, unexpired number,
 *      or an identical submission still in flight, makes no new vendor call;
 *   4. the vendor call through src/server/kyc (outside any DB transaction);
 *   5. the result stored on seller_verifications, with an event row.
 *
 * The per-document rules — name matching, GSTIN↔PAN linkage, FSSAI only for
 * food shops, Shop Act upload — and the admin queue build on this in Part 3.
 *
 * Full numbers exist only in memory during the call and as ciphertext at
 * rest. Views returned from here, events and logs carry the masked form only.
 */
import { and, asc, eq } from "drizzle-orm";

import {
  parseSellerDocNumber,
  SELLER_DOC_TYPES,
  type SellerDocType,
  type SellerVerificationStatus,
} from "@/lib/kyc/doc-formats";
import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { docBlindIndex, encryptSecret } from "@/lib/pan-crypto";
import { db, type DbClient } from "@/server/db";
import {
  sellerVerificationEvents,
  sellerVerifications,
  shops,
  type SellerVerification,
  type Shop,
  type UserRole,
} from "@/server/db/schema";
import { verifyDocument, type VerifyExtraFields } from "@/server/kyc";

export interface Actor {
  id: string;
  role: UserRole;
}

/**
 * Version of the consent notice shown next to the "I agree" checkbox. Bump it
 * whenever that wording changes, so each stored consent says which text the
 * seller agreed to.
 */
export const SELLER_VERIFICATION_CONSENT_VERSION = "2026-10-05";

/** A second identical submission within this window rides on the first instead of paying again. */
const IN_FLIGHT_WINDOW_MS = 30_000;

/** What callers and APIs get — never the ciphertext or blind index. */
export interface SellerVerificationView {
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

export function toView(row: SellerVerification): SellerVerificationView {
  return {
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
    details: (row.details ?? {}) as Record<string, unknown>,
    submittedAt: row.submittedAt,
    verifiedAt: row.verifiedAt,
    reviewedAt: row.reviewedAt,
    reviewNote: row.reviewNote,
  };
}

function emptyView(docType: SellerDocType): SellerVerificationView {
  return {
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

async function loadShopFor(shopId: string, actor: Actor): Promise<Shop> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop || shop.deletedAt) throw notFound("Shop");
  if (shop.ownerId !== actor.id && actor.role !== "ADMIN" && actor.role !== "OPERATOR") {
    throw forbidden("This shop does not belong to you.");
  }
  return shop;
}

/**
 * Two-letter state for state-specific lookups (Shop Act). Shops store a PIN
 * code but no state; PIN codes 40xxxx–44xxxx are Maharashtra.
 */
export function stateCodeForPincode(pincode: string | null | undefined): string | undefined {
  const prefix = Number((pincode ?? "").slice(0, 2));
  return prefix >= 40 && prefix <= 44 ? "MH" : undefined;
}

type EventInsert = typeof sellerVerificationEvents.$inferInsert;

async function recordEvent(client: DbClient, event: EventInsert): Promise<void> {
  await client.insert(sellerVerificationEvents).values(event);
}

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

  const doc = parsed.value;
  const numberHash = docBlindIndex(docType, doc.normalized);
  const consentVersion = input.consentVersion ?? SELLER_VERIFICATION_CONSENT_VERSION;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const ip = input.ipAddress ?? null;
  const actorFields = { actorId: actor.id, actorRole: actor.role, ipAddress: ip };

  // Claim the row under a lock, so two clicks or two tabs cannot both pay.
  const claim = await db.transaction(async (tx) => {
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
    const base = { verificationId: row.id, shopId, docType, ...actorFields };

    if (sameNumber && row.status === "VERIFIED" && (!row.validUntil || row.validUntil >= today)) {
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
          : { verifiedName: null, nameMatchScore: null, details: {}, validUntil: null, verifiedAt: null }),
        attemptCount: attempt,
        lastAttemptAt: now,
        lastErrorCode: null,
        idempotencyKey,
        consentGivenAt: now,
        consentVersion,
        submittedBy: actor.id,
        submittedAt: now,
        updatedAt: now,
      })
      .where(eq(sellerVerifications.id, row.id))
      .returning();

    await recordEvent(tx, {
      ...base,
      eventType: "CONSENT_GIVEN",
      note: `Consent notice ${consentVersion}`,
      details: { purpose: "seller_document_verification", numberMasked: doc.masked },
    });
    await recordEvent(tx, {
      ...base,
      eventType: "SUBMITTED",
      fromStatus: row.status,
      toStatus: "PENDING",
      details: { numberMasked: doc.masked, attempt },
    });
    return { kind: "call" as const, row: claimed, idempotencyKey };
  });

  if (claim.kind === "done") return toView(claim.row);

  const result = await verifyDocument(
    docType,
    doc.normalized,
    {
      nameToMatch: shop.legalBusinessName ?? shop.ownerName ?? shop.name,
      stateCode: stateCodeForPincode(shop.pincode),
      city: shop.city ?? undefined,
      ...input.extra,
    },
    claim.idempotencyKey,
  );

  const record = result.record;
  const details: Record<string, unknown> = record
    ? {
        docStatus: record.docStatus,
        tradeName: record.tradeName ?? null,
        ownerName: record.ownerName ?? null,
        entityType: record.entityType ?? null,
        stateCode: record.stateCode ?? null,
        pincode: record.pincode ?? null,
        address: record.address ?? null,
        category: record.category ?? null,
        linkedPanMatchesGstin:
          docType === "GSTIN" && record.linkedPan ? record.linkedPan.toUpperCase() === doc.gstEmbeddedPan : null,
        vendorNameMatchScore: record.vendorNameMatchScore ?? null,
      }
    : {};

  const finished = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(sellerVerifications)
      .set({
        status: result.status,
        verifiedName: result.matchedName,
        validUntil: result.validUntil,
        details,
        providerId: result.providerId,
        providerRef: result.rawRef,
        lastErrorCode: result.errorCode,
        verifiedAt: result.status === "VERIFIED" ? new Date() : null,
        updatedAt: new Date(),
      })
      // Only if no newer submission claimed the row while the vendor was answering.
      .where(and(eq(sellerVerifications.id, claim.row.id), eq(sellerVerifications.idempotencyKey, claim.idempotencyKey)))
      .returning();

    if (updated) {
      await recordEvent(tx, {
        verificationId: claim.row.id,
        shopId,
        docType,
        ...actorFields,
        eventType: "VENDOR_RESULT",
        fromStatus: "PENDING",
        toStatus: result.status,
        providerId: result.providerId,
        providerRef: result.rawRef,
        errorCode: result.errorCode,
        details: { numberMasked: doc.masked, docStatus: record?.docStatus ?? null },
      });
    }
    return updated;
  });

  if (finished) return toView(finished);
  const latest = await db.query.sellerVerifications.findFirst({ where: eq(sellerVerifications.id, claim.row.id) });
  return toView(latest ?? claim.row);
}

/** All five documents for a shop, NOT_SUBMITTED for any never sent. */
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
