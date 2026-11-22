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
 * A shop registered through the onboarding wizard follows the owner's rule of 21-Nov-2026 (DF-08,
 * docs/decision-log.md): "PAN / GST and, if applicable, FSSAI are must-have; for the rest, the shop
 * can go live with the owner's promise to upload them later". It pays once its GSTIN or PAN has been
 * checked, a food shop's FSSAI licence is on file (or with GoKesari's team), and every other mandatory
 * document (Shop Act, a pharmacy's drug licence, a clinic's or professional's registration) is either
 * on file or promised within shopDocumentFollowUp.promiseDays. It goes live on payment when the
 * GSTIN / PAN and FSSAI checks VERIFIED them; the 1st / 15th follow-up chases what was promised and
 * suspends the shop after the promised date.
 * One registered with "upload documents later" (0120) pays without a GSTIN / PAN, and goes live on payment.
 *
 * DF-09 (owner, 22-Nov-2026): which documents are must-have, which may follow on the promise, and which
 * are optional is now the admin's choice, per document and shop type (shop-document-rules.ts). The
 * seeded rules are DF-08's; GSTIN or PAN stays a must-have outside those rules.
 */
import { eq } from "drizzle-orm";

import { formatDisplayDate, todayIn } from "@/lib/dates";
import { conflict, forbidden, notFound } from "@/lib/errors";
import { SELLER_DOC_LABELS, SELLER_DOC_TYPES, type SellerDocType } from "@/lib/kyc/doc-formats";
import { listJoin } from "@/lib/shop-document-rules";
import { db, type DbClient } from "@/server/db";
import { sellerVerifications, shops, type Shop, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { getRule } from "./settings";
import { hasDocumentWaiver, isDocumentsLaterShop, isWizardRegisteredShop, missingMandatoryDocuments } from "./shop-onboarding";
import { requirementsOnFile, type RequirementOnFile } from "./shop-document-rules";

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
  /**
   * DF-08 (wizard shops): a food shop's FSSAI licence is not on file and not with the team — it must be
   * uploaded before payment. Always false for other shops (their own gate lists FSSAI under `missing`).
   */
  fssaiNeeded: boolean;
  /**
   * DF-09 (wizard shops): the must-have documents (admin rules) not on file and not with the team, FSSAI
   * included — all uploaded before payment. Labels. Empty for other shops.
   */
  mustHave: string[];
  /** What the promise covers (labels): the missing documents, or for a wizard shop those that may follow go-live. */
  promiseCovers: string[];
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
  const promised = shop.documentsPromisedAt !== null;
  const waived = await hasDocumentWaiver(shop.id, client);
  // A wizard shop (owner, 21-Nov-2026, DF-08): GSTIN or PAN checked, FSSAI on file for a food shop, and the
  // rest on file or promised. The promise replaces DI-14's silent 90 days for everything but FSSAI.
  if (await isWizardRegisteredShop(shop.id, client)) {
    const missing = (await missingMandatoryDocuments(shop, client, { countDeferred: true })) as SellerDocType[];
    // The GSTIN or PAN was checked and not refused (verified, still being checked, or with the team; never the
    // "not GST-registered" declaration). Only a verified one is approved automatically.
    const identityChecked = rows.some(
      (r) => (r.docType === "GSTIN" || r.docType === "PAN") && ["VERIFIED", "PENDING", "MANUAL_REVIEW"].includes(r.status) && r.errorCode !== "gst_declaration_review",
    );
    // 0120: registered with "upload documents later" — the fee is paid without a GSTIN / PAN.
    const identityOk = identityChecked || (await isDocumentsLaterShop(shop.id, client));
    const docs = await requirementsOnFile(shop, client);
    const mustHaveDocs = await wizardMustHaveMissing(shop, docs, client);
    const fssaiNeeded = mustHaveDocs.some((d) => d.key === "FSSAI");
    const covers = wizardDocumentsAfterGoLive(docs);
    return {
      verified,
      missing: fssaiNeeded && !missing.includes("FSSAI") ? [...missing, "FSSAI"] : missing,
      inReview: [],
      promisedAt: shop.documentsPromisedAt,
      dueAt: shop.documentsDueAt,
      waived,
      canPay: waived || (identityOk && mustHaveDocs.length === 0 && (covers.length === 0 || promised)),
      canPromise: identityOk && covers.length > 0 && !promised,
      fssaiNeeded,
      mustHave: mustHaveDocs.map((d) => d.label),
      promiseCovers: covers,
    };
  }
  const { missing, inReview } = splitMissing((await missingMandatoryDocuments(shop, client)) as SellerDocType[], rows);
  return {
    verified,
    missing,
    inReview,
    promisedAt: shop.documentsPromisedAt,
    dueAt: shop.documentsDueAt,
    waived,
    canPay: waived || (verified.length > 0 && (missing.length === 0 || promised)),
    canPromise: verified.length > 0 && missing.length > 0 && !promised,
    fssaiNeeded: false,
    mustHave: [],
    promiseCovers: missing.map((d) => SELLER_DOC_LABELS[d]),
  };
}

/**
 * DF-09: the must-have documents (the admin's rules; DF-08's FSSAI for food shops by default) a wizard
 * shop has not given: not on file and not with GoKesari's team. FSSAI keeps its own test
 * (document-uploads.ts fssaiBlocksRegistration, which an admin's waiver lifts); the approval itself still
 * needs FSSAI on file (assertFssaiAllowsApproval), so a licence still with the team means the paid shop
 * waits for an admin.
 */
async function wizardMustHaveMissing(shop: Pick<Shop, "id" | "shopType">, docs: RequirementOnFile[], client: DbClient): Promise<RequirementOnFile[]> {
  const out: RequirementOnFile[] = [];
  for (const doc of docs) {
    if (doc.level !== "MUST_HAVE" || doc.onFile) continue;
    if (doc.key === "FSSAI") {
      // Loaded on use: document-uploads.ts reaches shops.ts, which imports this file.
      const { fssaiBlocksRegistration } = await import("./document-uploads");
      if ((await fssaiBlocksRegistration(shop, client)) === null) continue;
    }
    out.push(doc);
  }
  return out;
}

/**
 * DF-08 / DF-09: the documents a wizard shop may upload after going live, on the owner's promise — those
 * the admin's rules set to PROMISE (by default the Shop Act, a pharmacy's drug licence, a clinic's or
 * professional's registration) that are not on file and not with the team. Labels.
 */
export function wizardDocumentsAfterGoLive(docs: RequirementOnFile[]): string[] {
  return docs.filter((d) => d.level === "PROMISE" && !d.onFile).map((d) => d.label);
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
    if (gate.mustHave.length > 0 && !gate.missing.some((d) => d === "GSTIN" || d === "PAN")) {
      throw mustHaveConflict(gate);
    }
    if (gate.mustHave.length === 0 && gate.canPromise) {
      const { promiseDays } = await getRule("shopDocumentFollowUp");
      throw conflict(
        `Please upload ${gate.promiseCovers.join(", ")}, or confirm that you will upload ${gate.promiseCovers.length > 1 ? "them" : "it"} within ${promiseDays} days, before paying the registration fee.`,
        { reason: "DOCUMENTS_PROMISE_NEEDED", missing: gate.promiseCovers },
      );
    }
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

/**
 * The must-have documents are missing (wizard shops). FSSAI alone keeps its own words and reason
 * (FSSAI_REQUIRED); any other must-have (DF-09) is DOCUMENTS_REQUIRED.
 */
export function mustHaveConflict(gate: Pick<ShopDocumentGate, "mustHave" | "fssaiNeeded" | "missing">) {
  if (gate.fssaiNeeded && gate.mustHave.length === 1) {
    return conflict("Your shop sells food, so an FSSAI licence is required by law. Please upload your FSSAI licence before paying the registration fee.", {
      reason: "FSSAI_REQUIRED",
      missing: gate.missing,
    });
  }
  return conflict(
    `${listJoin(gate.mustHave)} ${gate.mustHave.length > 1 ? "are" : "is"} required by law for your type of shop. Please upload ${gate.mustHave.length > 1 ? "them" : "it"} before paying the registration fee.`,
    { reason: "DOCUMENTS_REQUIRED", missing: gate.mustHave },
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
 * The owner ticks "I will provide all relevant documents within <promiseDays> days" (Add my shop →
 * fee page, or — DF-08 — the signup wizard's documents screen). Needs one verified document (a wizard
 * shop: its GSTIN or PAN checked); given once (a second tick keeps the first date).
 */
export async function promiseShopDocuments(
  shopId: string,
  actor: { id: string; role: UserRole },
  source: "REGISTRATION_FEE_PAGE" | "SIGNUP_WIZARD" = "REGISTRATION_FEE_PAGE",
): Promise<ShopDocumentGate> {
  return db.transaction(async (tx) => {
    const [shop] = await tx.select().from(shops).where(eq(shops.id, shopId)).for("update");
    if (!shop || shop.deletedAt) throw notFound("Shop");
    if (shop.ownerId !== actor.id) throw forbidden("Only the shop's owner can give this promise.");
    if (shop.status !== "PENDING_APPROVAL") throw conflict("This shop's registration is no longer waiting.");
    const gate = await shopDocumentGate(shop, tx);
    if (gate.promisedAt) return gate;
    if (gate.promiseCovers.length === 0) return gate;
    if (!gate.canPromise) {
      throw conflict("Please get at least one of your documents verified (for example your PAN) first.", { reason: "NO_VERIFIED_DOCUMENT" });
    }
    const { promisedAt, dueAt } = await setDocumentsPromise(tx, shop.id);
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_DOCUMENTS_PROMISED,
        entityType: "shop",
        entityId: shop.id,
        newValue: { missing: gate.promiseCovers, dueAt: dueAt.toISOString(), source },
      },
      tx,
    );
    return shopDocumentGate({ ...shop, documentsPromisedAt: promisedAt, documentsDueAt: dueAt }, tx);
  });
}
