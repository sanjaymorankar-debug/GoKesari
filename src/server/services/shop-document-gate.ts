/**
 * Owner decision, 29 Oct 2026 (docs/shop-documents-2026-10): the registration fee is paid
 * only after the shop's documents are verified, at least one of them. An owner who can't
 * provide the rest yet ticks "I will provide all relevant documents within 30 days"; that
 * shop is never approved automatically: an admin or operator inspects and approves it, and
 * the 1st / 15th follow-up (shop-document-follow-up.ts) chases the missing documents.
 *
 * "Verified" is a seller_verifications row with status VERIFIED. The mandatory list is
 * missingMandatoryDocuments' (PAN, GSTIN or the no-GST declaration, Shop Act, FSSAI for food).
 *
 * A shop registered through the onboarding wizard follows the later decision (29 Oct 2026, "follow
 * the brief", docs/shop-onboarding-wizard-2026-10/BRIEF_REDESIGN.md): it pays once its GSTIN or PAN
 * has been checked, and goes live on payment when that check VERIFIED it; the promise is not used there.
 * One registered with "upload documents later" (0120) pays without any, and goes live on payment.
 */
import { eq } from "drizzle-orm";

import { formatDisplayDate, todayIn } from "@/lib/dates";
import { conflict, forbidden, notFound } from "@/lib/errors";
import { SELLER_DOC_TYPES, type SellerDocType } from "@/lib/kyc/doc-formats";
import { db, type DbClient } from "@/server/db";
import { sellerVerifications, shops, type Shop, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { getRule } from "./settings";
import { hasDocumentWaiver, isDocumentsLaterShop, isWizardRegisteredShop, missingMandatoryDocuments } from "./shop-onboarding";

const DAY_MS = 86_400_000;

/** "28 Nov 2026" — the promise's due date as the owner and the team read it (India time). */
export const documentsDueLabel = (at: Date) => formatDisplayDate(todayIn("Asia/Kolkata", at));

export interface ShopDocumentGate {
  /** Documents checked and VERIFIED. */
  verified: SellerDocType[];
  /** Mandatory documents the owner still has to provide (not given, being checked, or rejected). */
  missing: SellerDocType[];
  /** Waiting for GoKesari's team, not for the owner: the "not GST-registered" declaration. */
  inReview: SellerDocType[];
  promisedAt: Date | null;
  dueAt: Date | null;
  /** An admin approved the shop without its documents (0109). */
  waived: boolean;
  /** The fee may be paid: at least one verified document, and nothing missing or the promise given. */
  canPay: boolean;
  /** The promise may be given now: at least one verified document and something missing. */
  canPromise: boolean;
}

export async function shopDocumentGate(
  shop: Pick<Shop, "id" | "shopType" | "documentsPromisedAt" | "documentsDueAt">,
  client: DbClient = db,
): Promise<ShopDocumentGate> {
  const rows = await client
    .select({ docType: sellerVerifications.docType, status: sellerVerifications.status, errorCode: sellerVerifications.lastErrorCode })
    .from(sellerVerifications)
    .where(eq(sellerVerifications.shopId, shop.id));
  const verified = SELLER_DOC_TYPES.filter((d) => rows.some((r) => r.docType === d && r.status === "VERIFIED"));
  // A wizard shop (owner decision 29 Oct 2026, "follow the brief"): the fee may be paid once its
  // GSTIN — or PAN without one — has been checked. Approval then needs FSSAI too for a food shop; the
  // Shop Act and other documents come after go-live. No promise is asked for.
  if (await isWizardRegisteredShop(shop.id, client)) {
    const missing = (await missingMandatoryDocuments(shop, client, { countDeferred: true })) as SellerDocType[];
    // The GSTIN or PAN was checked and not refused (verified, still being checked, or with the team; never the
    // "not GST-registered" declaration). Only a verified one is approved automatically.
    const identityChecked = rows.some(
      (r) => (r.docType === "GSTIN" || r.docType === "PAN") && ["VERIFIED", "PENDING", "MANUAL_REVIEW"].includes(r.status) && r.errorCode !== "gst_declaration_review",
    );
    return {
      verified,
      missing,
      inReview: [],
      promisedAt: shop.documentsPromisedAt,
      dueAt: shop.documentsDueAt,
      waived: await hasDocumentWaiver(shop.id, client),
      // 0120: registered with "upload documents later" — the fee is paid without them.
      canPay: identityChecked || (await isDocumentsLaterShop(shop.id, client)),
      canPromise: false,
    };
  }
  const { missing, inReview } = splitMissing((await missingMandatoryDocuments(shop, client)) as SellerDocType[], rows);
  const waived = await hasDocumentWaiver(shop.id, client);
  const promised = shop.documentsPromisedAt !== null;
  return {
    verified,
    missing,
    inReview,
    promisedAt: shop.documentsPromisedAt,
    dueAt: shop.documentsDueAt,
    waived,
    canPay: waived || (verified.length > 0 && (missing.length === 0 || promised)),
    canPromise: verified.length > 0 && missing.length > 0 && !promised,
  };
}

/**
 * A shop without a GSTIN declares it is not GST-registered; the GSTIN row then waits in
 * MANUAL_REVIEW for GoKesari's team. That is not a document the owner can provide, so it is
 * neither promised nor chased — but it still keeps the shop from automatic approval.
 */
export function splitMissing(
  missing: SellerDocType[],
  rows: { docType: string; status: string; errorCode: string | null }[],
): { missing: SellerDocType[]; inReview: SellerDocType[] } {
  const declared = rows.some(
    (r) => r.docType === "GSTIN" && r.errorCode === "gst_declaration_review" && (r.status === "MANUAL_REVIEW" || r.status === "PENDING"),
  );
  return {
    missing: missing.filter((d) => !(d === "GSTIN" && declared)),
    inReview: declared && missing.includes("GSTIN") ? ["GSTIN"] : [],
  };
}

/** The fee checkout refuses until the gate opens. */
export async function assertDocumentsAllowPayment(shop: Shop): Promise<void> {
  // A shop a person already approved (or rejected) is past the gate: only a waiting registration is held.
  if (shop.status !== "PENDING_APPROVAL") return;
  const gate = await shopDocumentGate(shop);
  if (gate.canPay) return;
  if (await isWizardRegisteredShop(shop.id)) {
    throw conflict("A valid PAN or GST is required to register. Please get your GSTIN or PAN verified before paying the registration fee.", {
      reason: "IDENTITY_NOT_VERIFIED",
      missing: gate.missing,
    });
  }
  if (gate.verified.length === 0) {
    throw conflict("Please get at least one of your documents verified (for example your PAN) before paying the registration fee.", {
      reason: "NO_VERIFIED_DOCUMENT",
      missing: gate.missing,
    });
  }
  throw conflict(
    "Some documents are not verified yet. Verify them, or tick \"I will provide all relevant documents within 30 days\", before paying the registration fee.",
    { reason: "DOCUMENTS_MISSING", missing: gate.missing },
  );
}

/** The documents promise, set inside a transaction that already holds the shop (the wizard's submit). */
export async function setDocumentsPromise(tx: DbClient, shopId: string, at: Date = new Date()): Promise<{ promisedAt: Date; dueAt: Date }> {
  const { promiseDays } = await getRule("shopDocumentFollowUp");
  const dueAt = new Date(at.getTime() + promiseDays * DAY_MS);
  await tx.update(shops).set({ documentsPromisedAt: at, documentsDueAt: dueAt, updatedAt: new Date() }).where(eq(shops.id, shopId));
  return { promisedAt: at, dueAt };
}

/**
 * The owner ticks "I will provide all relevant documents within 30 days" (Add my shop → fee
 * page). Needs one verified document; given once (a second tick keeps the first date).
 */
export async function promiseShopDocuments(shopId: string, actor: { id: string; role: UserRole }): Promise<ShopDocumentGate> {
  return db.transaction(async (tx) => {
    const [shop] = await tx.select().from(shops).where(eq(shops.id, shopId)).for("update");
    if (!shop || shop.deletedAt) throw notFound("Shop");
    if (shop.ownerId !== actor.id) throw forbidden("Only the shop's owner can give this promise.");
    if (shop.status !== "PENDING_APPROVAL") throw conflict("This shop's registration is no longer waiting.");
    const gate = await shopDocumentGate(shop, tx);
    if (gate.promisedAt) return gate;
    if (gate.verified.length === 0) {
      throw conflict("Please get at least one of your documents verified (for example your PAN) first.", { reason: "NO_VERIFIED_DOCUMENT" });
    }
    if (gate.missing.length === 0) return gate;
    const { promisedAt, dueAt } = await setDocumentsPromise(tx, shop.id);
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_DOCUMENTS_PROMISED,
        entityType: "shop",
        entityId: shop.id,
        newValue: { missing: gate.missing, dueAt: dueAt.toISOString(), source: "REGISTRATION_FEE_PAGE" },
      },
      tx,
    );
    return { ...gate, promisedAt, dueAt, canPay: true, canPromise: false };
  });
}
