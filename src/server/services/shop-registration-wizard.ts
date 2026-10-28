/**
 * Onboarding wizard, step 2 (docs/shop-onboarding-wizard-2026-10): everything
 * after the GSTIN / PAN step, on the owner's draft —
 *
 *   DETAILS   shop type, categories, phone, turnover (the fee slab); name and
 *             address pre-filled from the GST record
 *   UDYAM     "Do you have Udyam?" → government check (optional)
 *   FSSAI     "Do you have FSSAI?" — asked of every shop, compulsory for a food
 *             shop type → government check (expiry, premises PIN)
 *   SHOP_ACT  number → government check where the state has one; Maharashtra
 *             has none, so the check goes to an admin (MANUAL_REVIEW)
 *   LOCATION  the map pin
 *   REVIEW    "Create my shop and pay": the shop is created from the draft
 *             (registerShop, with its duplicate checks and fee snapshot) and,
 *             in the same transaction, every check is copied to
 *             seller_verifications with the vendor's reference
 *   PAYMENT   the existing registration-fee checkout (Cashfree)
 *   WAITING / DONE  the payment webhook runs the instant approval; a wizard
 *             shop is approved in every district (owner decision B) with its
 *             Shop Act — and a no-GSTIN declaration — left for an admin's
 *             review (shop_deferred_document_reviews, 0113)
 *
 * Same safeguards as step 1: format check before any paid call, explicit
 * consent, the draft row claimed under a lock, a verified number served from
 * the stored result, an identical check in flight joined, the per-draft hourly
 * limit, vendor calls outside every transaction, and a result written only if
 * no newer check claimed the row. Numbers are kept as ciphertext, masked form
 * and blind index; views carry the masked form only.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { GST_DECLARATION_VERSION, SELLER_VERIFICATION_CONSENT_VERSION } from "@/lib/kyc/consent";
import { parseSellerDocNumber } from "@/lib/kyc/doc-formats";
import { bestNameMatch } from "@/lib/kyc/name-match";
import { conflict, notFound, validationFailed } from "@/lib/errors";
import { decryptSecret, docBlindIndex, encryptSecret } from "@/lib/pan-crypto";
import { isFoodBusinessShopType } from "@/lib/shop-types";
import { db, type DbClient } from "@/server/db";
import {
  shopDeferredDocumentReviews,
  shopRegistrationDraftChecks,
  shopRegistrationDrafts,
  shops,
  type DraftCheckDocType,
  type Shop,
  type ShopRegistrationDraft,
  type ShopRegistrationDraftCheck,
} from "@/server/db/schema";
import { recordShopAttributionSafely } from "@/server/dealers/attribution";
import { verifyDocument } from "@/server/kyc";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { assertRegistrationReferralCode, attributeRegistrationReferral } from "./referral-requests";
import { registrationFeeDue } from "./registration-fee-payment";
import { applyDocumentChecks, type ShopFacts } from "./seller-verification-checks";
import {
  importRegistrationCheck,
  importRegistrationGstDeclaration,
  stateCodeForPincode,
  type RegistrationCheck,
} from "./seller-verification";
import { getRule } from "./settings";
import {
  assertOwnerExists,
  CAN_CONTINUE,
  countCheck,
  findOpenDraft,
  IN_FLIGHT_WINDOW_MS,
  message,
  str,
  toDraftView,
  type Actor,
  type DraftCheckView,
  type ShopRegistrationDraftView,
} from "./shop-registration-draft";
import { assertShopType, loadShopTypeRegistry } from "./shop-types";
import { autoApproveShopIfReady, registerShop } from "./shops";

/* ---------------------------------------------------------------- types */

/** The shop details step. Name and address arrive pre-filled from the GST record; the owner may edit them. */
export interface DraftShopDetails {
  name: string;
  ownerName: string;
  phone: string;
  email: string | null;
  shopType: string;
  categoryIds: string[];
  annualTurnoverRupees: number | null;
  couponCode: string | null;
  referralCode: string | null;
  /** docs/dealer-programme: the dealer's employee who helped, if any. */
  employeeId: string | null;
  addressLine1: string;
  addressLine2: string | null;
  area: string | null;
  city: string;
  state: string | null;
  pincode: string;
  landmark: string | null;
}

export const WIZARD_STEPS = ["IDENTITY", "DETAILS", "UDYAM", "FSSAI", "SHOP_ACT", "LOCATION", "REVIEW", "PAYMENT", "WAITING", "DONE"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface WizardDocView {
  /** UDYAM / FSSAI: the owner's answer to "Do you have …?"; SHOP_ACT: always true. */
  has: boolean | null;
  check: (DraftCheckView & { validUntil: string | null }) | null;
  /** The step is settled: answered "no", or checked with a status that lets the owner go on. */
  done: boolean;
}

export interface WizardView extends ShopRegistrationDraftView {
  status: ShopRegistrationDraft["status"];
  details: DraftShopDetails | null;
  /** A food shop type: FSSAI cannot be skipped. */
  foodShop: boolean;
  udyam: WizardDocView;
  fssai: WizardDocView & { required: boolean };
  shopAct: WizardDocView;
  location: { latitude: string; longitude: string; address: string | null } | null;
  /** Once the shop exists (SUBMITTED / COMPLETED). */
  shop: {
    id: string;
    name: string;
    registrationNumber: string | null;
    status: Shop["status"];
    feeDuePaise: number;
    feePaymentStatus: Shop["feePaymentStatus"];
  } | null;
  /** Where the wizard resumes. */
  nextStep: WizardStep;
}

/* ---------------------------------------------------------------- views */

const DOC_MESSAGES: Partial<Record<DraftCheckDocType, Record<string, string>>> = {
  UDYAM: { name_mismatch: "The name on the Udyam record doesn't match your shop or owner name. You can carry on — our team will check it." },
  FSSAI: { name_mismatch: "The name on the FSSAI record doesn't match your shop or owner name. You can carry on — our team will check it." },
  SHOP_ACT: {
    vendor_unsupported:
      "Shop Act numbers can't be checked online in your state. You can carry on — after registration, upload your Shop Act certificate on Documents and our team will review it.",
    name_mismatch: "The name on the Shop Act record doesn't match your shop or owner name. You can carry on — our team will check it.",
  },
};

function checkView(docType: DraftCheckDocType, row: ShopRegistrationDraftCheck | undefined) {
  if (!row || !row.numberMasked) return null;
  const special = row.errorCode ? DOC_MESSAGES[docType]?.[row.errorCode] : undefined;
  return {
    numberMasked: row.numberMasked,
    status: row.status,
    errorCode: row.errorCode,
    message: row.status === "VERIFIED" || row.status === "PENDING" ? message(row.status, row.errorCode) : (special ?? message(row.status, row.errorCode)),
    validUntil: row.validUntil,
  };
}

const settled = (row: ShopRegistrationDraftCheck | undefined) => Boolean(row?.numberMasked && CAN_CONTINUE.includes(row.status));

function detailsOf(draft: ShopRegistrationDraft): DraftShopDetails | null {
  const d = draft.details as Partial<DraftShopDetails> | null;
  return d && typeof d.shopType === "string" ? (d as DraftShopDetails) : null;
}

async function isFoodShopType(shopType: string | undefined): Promise<boolean> {
  if (!shopType) return false;
  await loadShopTypeRegistry();
  return isFoodBusinessShopType(shopType);
}

async function loadChecks(draftId: string, client: DbClient = db): Promise<ShopRegistrationDraftCheck[]> {
  return client.select().from(shopRegistrationDraftChecks).where(eq(shopRegistrationDraftChecks.draftId, draftId));
}

export async function toWizardView(draft: ShopRegistrationDraft): Promise<WizardView> {
  const base = toDraftView(draft);
  const checks = await loadChecks(draft.id);
  const row = (t: DraftCheckDocType) => checks.find((c) => c.docType === t);
  const details = detailsOf(draft);
  const foodShop = await isFoodShopType(details?.shopType);

  const udyam: WizardDocView = { has: draft.hasUdyam, check: checkView("UDYAM", row("UDYAM")), done: draft.hasUdyam === false || (draft.hasUdyam === true && settled(row("UDYAM"))) };
  const fssaiDone = foodShop ? settled(row("FSSAI")) : draft.hasFssai === false || (draft.hasFssai === true && settled(row("FSSAI")));
  const fssai = { has: draft.hasFssai, check: checkView("FSSAI", row("FSSAI")), done: fssaiDone, required: foodShop };
  const shopAct: WizardDocView = { has: true, check: checkView("SHOP_ACT", row("SHOP_ACT")), done: settled(row("SHOP_ACT")) };
  const location = draft.latitude && draft.longitude && draft.locationConfirmedAt ? { latitude: draft.latitude, longitude: draft.longitude, address: draft.locationAddress } : null;

  let shop: WizardView["shop"] = null;
  if (draft.shopId) {
    const [s] = await db.select().from(shops).where(eq(shops.id, draft.shopId));
    if (s) {
      shop = {
        id: s.id,
        name: s.name,
        registrationNumber: s.registrationNumber,
        status: s.status,
        feeDuePaise: registrationFeeDue(s),
        feePaymentStatus: s.feePaymentStatus,
      };
    }
  }

  let nextStep: WizardStep;
  if (draft.status === "COMPLETED" || shop?.status === "APPROVED") nextStep = "DONE";
  else if (draft.status === "SUBMITTED") nextStep = shop && shop.feeDuePaise > 0 ? "PAYMENT" : "WAITING";
  else if (!base.canContinue) nextStep = "IDENTITY";
  else if (!details) nextStep = "DETAILS";
  else if (!udyam.done) nextStep = "UDYAM";
  else if (!fssai.done) nextStep = "FSSAI";
  else if (!shopAct.done) nextStep = "SHOP_ACT";
  else if (!location) nextStep = "LOCATION";
  else nextStep = "REVIEW";

  return { ...base, status: draft.status, details, foodShop, udyam, fssai, shopAct, location, shop, nextStep };
}

/**
 * The owner's registration in the wizard: the OPEN draft, else the latest one
 * already turned into a shop (to show payment, waiting or done), else null.
 */
export async function getWizardDraft(actor: Pick<Actor, "id">): Promise<WizardView | null> {
  const open = await findOpenDraft(actor.id);
  if (open) return toWizardView(open);
  const [latest] = await db
    .select()
    .from(shopRegistrationDrafts)
    .where(and(eq(shopRegistrationDrafts.ownerId, actor.id), inArray(shopRegistrationDrafts.status, ["SUBMITTED", "COMPLETED"])))
    .orderBy(desc(shopRegistrationDrafts.updatedAt))
    .limit(1);
  return latest ? toWizardView(latest) : null;
}

/* --------------------------------------------------------------- guards */

/** The owner's OPEN draft past the GSTIN / PAN step, locked for this transaction. */
async function lockReadyDraft(tx: DbClient, ownerId: string): Promise<ShopRegistrationDraft> {
  const [draft] = await tx
    .select()
    .from(shopRegistrationDrafts)
    .where(and(eq(shopRegistrationDrafts.ownerId, ownerId), eq(shopRegistrationDrafts.status, "OPEN")))
    .for("update");
  if (!draft) throw notFound("Registration in progress");
  if (!toDraftView(draft).canContinue) {
    throw conflict("Please finish the GSTIN or PAN step first.", { reason: "IDENTITY_STEP_OPEN" });
  }
  return draft;
}

/* ----------------------------------------------------------- shop details */

export async function saveDraftDetails(input: { actor: Actor; details: DraftShopDetails }): Promise<WizardView> {
  const { actor, details } = input;
  await assertShopType(details.shopType);
  if (details.annualTurnoverRupees == null && (await getRule("registrationFeeByTurnover")).enabled) {
    throw validationFailed("Please check the highlighted fields.", {
      fields: { annualTurnover: "Enter your annual turnover — it sets the registration fee." },
    });
  }
  // A referral code the platform requires (or one that is not valid) is caught here, not at payment.
  await assertRegistrationReferralCode(details.referralCode);
  const foodShop = await isFoodShopType(details.shopType);

  const draft = await db.transaction(async (tx) => {
    const locked = await lockReadyDraft(tx, actor.id);
    const [updated] = await tx
      .update(shopRegistrationDrafts)
      // A food shop type answers the FSSAI question by itself.
      .set({ details: { ...details }, ...(foodShop ? { hasFssai: true } : {}), updatedAt: new Date() })
      .where(eq(shopRegistrationDrafts.id, locked.id))
      .returning();
    return updated;
  });
  return toWizardView(draft);
}

/* ----------------------------------------------- Udyam, FSSAI, Shop Act */

/** "I don't have Udyam / FSSAI." A food shop cannot answer no to FSSAI. */
export async function answerDraftDocument(input: { actor: Actor; docType: "UDYAM" | "FSSAI"; has: boolean }): Promise<WizardView> {
  const draft = await db.transaction(async (tx) => {
    const locked = await lockReadyDraft(tx, input.actor.id);
    if (input.docType === "FSSAI" && !input.has && (await isFoodShopType(detailsOf(locked)?.shopType))) {
      throw validationFailed("A shop that sells food needs an FSSAI licence or registration. Please enter its number.", {
        fields: { fssai: "Required for a food shop." },
      });
    }
    const [updated] = await tx
      .update(shopRegistrationDrafts)
      .set({ ...(input.docType === "UDYAM" ? { hasUdyam: input.has } : { hasFssai: input.has }), updatedAt: new Date() })
      .where(eq(shopRegistrationDrafts.id, locked.id))
      .returning();
    return updated;
  });
  return toWizardView(draft);
}

/** The draft as the document rules see a shop: names from the GST / PAN records and the details step. */
function draftFacts(draft: ShopRegistrationDraft, foodShop: boolean): ShopFacts {
  const details = detailsOf(draft);
  const pincode = details?.pincode ?? str(draft.gstRecord?.pincode);
  return {
    ownerName: details?.ownerName ?? str(draft.panRecord?.name),
    legalBusinessName: str(draft.gstRecord?.legalName),
    shopName: details?.name ?? str(draft.gstRecord?.tradeName) ?? "",
    pincode,
    stateCode: stateCodeForPincode(pincode),
    isFoodBusiness: foodShop,
  };
}

export interface SubmitDraftDocumentInput {
  actor: Actor;
  docType: DraftCheckDocType;
  number: string;
  /** Must be true: the owner agreed to the government check. */
  consentGiven: boolean;
  ipAddress?: string | null;
}

/** Checks a Udyam, FSSAI or Shop Act number with the government source and keeps the result on the draft. */
export async function submitDraftDocument(input: SubmitDraftDocumentInput): Promise<WizardView> {
  const { actor, docType } = input;
  const parsed = parseSellerDocNumber(docType, input.number);
  if (!parsed.ok) throw validationFailed("Please check the highlighted fields.", { fields: { number: parsed.error } });
  if (!input.consentGiven) throw validationFailed("Please agree to the verification consent before we check this number.");
  const doc = parsed.value;
  await assertOwnerExists(actor.id);
  const numberHash = docBlindIndex(docType, doc.normalized);
  const now = new Date();

  type Claim = { kind: "done"; draftId: string } | { kind: "call"; draftId: string; key: string };
  const claim = await db.transaction(async (tx): Promise<Claim> => {
    const draft = await lockReadyDraft(tx, actor.id);
    // Locked through the draft: the check row's only unique key is its primary key.
    await tx.insert(shopRegistrationDraftChecks).values({ draftId: draft.id, docType }).onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(shopRegistrationDraftChecks)
      .where(and(eq(shopRegistrationDraftChecks.draftId, draft.id), eq(shopRegistrationDraftChecks.docType, docType)));
    const answered = docType === "UDYAM" ? { hasUdyam: true } : docType === "FSSAI" ? { hasFssai: true } : {};
    const sameNumber = row.numberHash === numberHash;
    const stillValid = !row.validUntil || row.validUntil >= now.toISOString().slice(0, 10);
    if (sameNumber && row.status === "VERIFIED" && stillValid) {
      await tx.update(shopRegistrationDrafts).set({ ...answered, updatedAt: now }).where(eq(shopRegistrationDrafts.id, draft.id));
      return { kind: "done", draftId: draft.id };
    }
    if (sameNumber && row.status === "PENDING" && row.checkedAt && now.getTime() - row.checkedAt.getTime() < IN_FLIGHT_WINDOW_MS) {
      return { kind: "done", draftId: draft.id };
    }
    const counted = await countCheck(tx, draft, now);
    await tx.update(shopRegistrationDrafts).set({ ...counted, ...answered, updatedAt: now }).where(eq(shopRegistrationDrafts.id, draft.id));
    const key = `${draft.id}:${docType.toLowerCase()}:${now.getTime()}`;
    await tx
      .update(shopRegistrationDraftChecks)
      .set({
        numberEncrypted: encryptSecret(doc.normalized),
        numberMasked: doc.masked,
        numberHash,
        status: "PENDING",
        errorCode: null,
        idempotencyKey: key,
        checkedAt: now,
        consentGivenAt: now,
        consentVersion: SELLER_VERIFICATION_CONSENT_VERSION,
        // A new number invalidates everything learned about the old one. The form as typed (a Shop Act
        // number's slashes) is kept for the shop's record — as ciphertext, like the number.
        ...(sameNumber
          ? {}
          : {
              record: { displayEncrypted: encryptSecret(input.number.trim().toUpperCase().replace(/\s+/g, " ")) },
              validUntil: null,
              verifiedAt: null,
              providerId: null,
              providerRef: null,
            }),
        updatedAt: now,
      })
      .where(and(eq(shopRegistrationDraftChecks.draftId, draft.id), eq(shopRegistrationDraftChecks.docType, docType)));
    return { kind: "call", draftId: draft.id, key };
  });

  if (claim.kind === "call") {
    const [draft] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, claim.draftId));
    const facts = draftFacts(draft, await isFoodShopType(detailsOf(draft)?.shopType));
    const rule = await getRule("sellerVerification");
    const result = await verifyDocument(
      docType,
      doc.normalized,
      {
        nameToMatch: facts.legalBusinessName ?? facts.ownerName ?? facts.shopName,
        stateCode: facts.stateCode,
        city: detailsOf(draft)?.city ?? undefined,
      },
      claim.key,
    );
    const judged = applyDocumentChecks({ docType, vendorStatus: result.status, record: result.record, shop: facts, nameMatchAutoApprove: rule.nameMatchAutoApprove });
    const checkedAt = new Date();
    const [current] = await db
      .select({ record: shopRegistrationDraftChecks.record })
      .from(shopRegistrationDraftChecks)
      .where(and(eq(shopRegistrationDraftChecks.draftId, claim.draftId), eq(shopRegistrationDraftChecks.docType, docType)));
    await db
      .update(shopRegistrationDraftChecks)
      .set({
        status: judged.status,
        errorCode: judged.errorCode ?? result.errorCode,
        record: {
          displayEncrypted: current?.record?.displayEncrypted ?? null,
          ...(result.record
            ? {
                docStatus: result.record.docStatus,
                name: result.record.name ?? null,
                tradeName: result.record.tradeName ?? null,
                ownerName: result.record.ownerName ?? null,
                category: result.record.category ?? null,
                stateCode: result.record.stateCode ?? null,
                pincode: result.record.pincode ?? null,
              }
            : {}),
          nameScore: judged.checks.nameScore,
          pincodeMatch: judged.checks.pincodeMatch,
          matchedShopName: judged.checks.matchedShopName,
        },
        validUntil: result.validUntil,
        providerId: result.providerId,
        providerRef: result.rawRef,
        verifiedAt: judged.status === "VERIFIED" ? checkedAt : null,
        updatedAt: checkedAt,
      })
      // Only if no newer check claimed the row while the vendor was answering.
      .where(and(eq(shopRegistrationDraftChecks.draftId, claim.draftId), eq(shopRegistrationDraftChecks.docType, docType), eq(shopRegistrationDraftChecks.idempotencyKey, claim.key)));
  }

  const [final] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, claim.draftId));
  if (claim.kind === "call") {
    const [row] = await loadChecks(final.id).then((rows) => rows.filter((r) => r.docType === docType));
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SHOP_REGISTRATION_DRAFT_CHECKED,
      entityType: "shop_registration_draft",
      entityId: final.id,
      ipAddress: input.ipAddress ?? null,
      newValue: { docType, number: row?.numberMasked ?? doc.masked, status: row?.status ?? "PENDING" },
    });
  }
  return toWizardView(final);
}

/* ---------------------------------------------------------------- the map */

export async function saveDraftLocation(input: { actor: Actor; latitude: number; longitude: number; address?: string | null }): Promise<WizardView> {
  const { latitude, longitude } = input;
  // India's bounding box: a pin anywhere else is a slip of the finger.
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < 6 || latitude > 37.5 || longitude < 68 || longitude > 97.5) {
    throw validationFailed("Please place the pin on your shop in India.", { fields: { location: "Place the pin on your shop." } });
  }
  const draft = await db.transaction(async (tx) => {
    const locked = await lockReadyDraft(tx, input.actor.id);
    const [updated] = await tx
      .update(shopRegistrationDrafts)
      .set({
        latitude: latitude.toFixed(7),
        longitude: longitude.toFixed(7),
        locationAddress: input.address?.trim().slice(0, 300) || null,
        locationConfirmedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(shopRegistrationDrafts.id, locked.id))
      .returning();
    return updated;
  });
  return toWizardView(draft);
}

/* -------------------------------------------------------- draft → shop */

const REVIEW_AFTER_GO_LIVE = "Onboarding wizard: live after payment, reviewed by an admin afterwards (owner decision B, 28 Oct 2026)";

/** Every check on the draft as the shop's seller verification. */
function registrationChecks(draft: ShopRegistrationDraft, checks: ShopRegistrationDraftCheck[], details: DraftShopDetails, threshold: number): RegistrationCheck[] {
  const out: RegistrationCheck[] = [];
  const gst = draft.gstRecord ?? {};
  if (draft.route === "GSTIN" && draft.gstinEncrypted && draft.gstinMasked && draft.gstinHash) {
    out.push({
      docType: "GSTIN",
      status: draft.gstStatus,
      numberEncrypted: draft.gstinEncrypted,
      numberMasked: draft.gstinMasked,
      numberHash: draft.gstinHash,
      normalized: decryptSecret(draft.gstinEncrypted),
      verifiedName: str(gst.legalName),
      nameMatchScore: null,
      validUntil: null,
      details: {
        docStatus: gst.docStatus ?? null,
        recordName: gst.legalName ?? null,
        tradeName: gst.tradeName ?? null,
        entityType: gst.constitution ?? null,
        stateCode: gst.stateCode ?? null,
        pincode: gst.pincode ?? null,
        address: gst.address ?? null,
        panLinked: gst.panLinked ?? null,
        ...(draft.panHash ? { embeddedPanHash: draft.panHash } : {}),
      },
      providerId: draft.gstProviderId,
      providerRef: draft.gstProviderRef,
      errorCode: draft.gstErrorCode,
      idempotencyKey: draft.gstIdempotencyKey,
      consentGivenAt: draft.consentGivenAt,
      consentVersion: draft.consentVersion,
      checkedAt: draft.gstCheckedAt,
      verifiedAt: draft.gstVerifiedAt,
    });
  }
  if (draft.panEncrypted && draft.panMasked && draft.panHash) {
    const pan = draft.panRecord ?? {};
    let status = draft.panStatus;
    let errorCode = draft.panErrorCode;
    let score = draft.panNameMatchScore;
    // No GST record to compare with: the PAN holder must be the owner (or the business) named on the shop.
    if (draft.route === "PAN_ONLY" && status === "VERIFIED" && str(pan.name)) {
      score = bestNameMatch([str(pan.name)], [details.ownerName, details.name]).score;
      if (score < threshold) {
        status = "MANUAL_REVIEW";
        errorCode = "name_mismatch";
      }
    }
    out.push({
      docType: "PAN",
      status,
      numberEncrypted: draft.panEncrypted,
      numberMasked: draft.panMasked,
      numberHash: draft.panHash,
      normalized: decryptSecret(draft.panEncrypted),
      verifiedName: str(pan.name),
      nameMatchScore: score,
      validUntil: null,
      details: { docStatus: pan.docStatus ?? null, recordName: pan.name ?? null, holderType: pan.holderType ?? null },
      providerId: draft.panProviderId,
      providerRef: draft.panProviderRef,
      errorCode,
      idempotencyKey: draft.panIdempotencyKey,
      consentGivenAt: draft.consentGivenAt,
      consentVersion: draft.consentVersion,
      checkedAt: draft.panCheckedAt,
      verifiedAt: status === "VERIFIED" ? draft.panVerifiedAt : null,
    });
  }
  for (const row of checks) {
    if (!row.numberEncrypted || !row.numberMasked || !row.numberHash || row.status === "NOT_SUBMITTED") continue;
    if (row.docType === "UDYAM" && draft.hasUdyam !== true) continue;
    if (row.docType === "FSSAI" && draft.hasFssai !== true) continue;
    const record = row.record ?? {};
    out.push({
      docType: row.docType,
      status: row.status,
      numberEncrypted: row.numberEncrypted,
      numberMasked: row.numberMasked,
      numberHash: row.numberHash,
      normalized: decryptSecret(row.numberEncrypted),
      verifiedName: str(record.name) ?? str(record.tradeName) ?? str(record.ownerName),
      nameMatchScore: typeof record.nameScore === "number" ? record.nameScore : null,
      validUntil: row.validUntil,
      details: {
        docStatus: record.docStatus ?? null,
        recordName: record.name ?? null,
        tradeName: record.tradeName ?? null,
        ownerName: record.ownerName ?? null,
        category: record.category ?? null,
        stateCode: record.stateCode ?? null,
        pincode: record.pincode ?? null,
        pincodeMatch: record.pincodeMatch ?? null,
        matchedShopName: record.matchedShopName ?? null,
      },
      providerId: row.providerId,
      providerRef: row.providerRef,
      errorCode: row.errorCode,
      idempotencyKey: row.idempotencyKey,
      consentGivenAt: row.consentGivenAt,
      consentVersion: row.consentVersion,
      checkedAt: row.checkedAt,
      verifiedAt: row.verifiedAt,
    });
  }
  return out;
}

const plain = (row: ShopRegistrationDraftCheck | undefined, include = true): string | null => {
  if (!include || !row?.numberEncrypted) return null;
  const typed = str(row.record?.displayEncrypted);
  return typed ? decryptSecret(typed) : decryptSecret(row.numberEncrypted);
};

/**
 * "Create my shop and pay": the shop is created from the draft — the same
 * registration as Add my shop (duplicate checks, fee snapshot, referral code,
 * role) — and every government check is copied to seller_verifications in the
 * same transaction. Returns the wizard at its payment step. Idempotent: a
 * draft already turned into a shop is returned as it is.
 */
export async function submitDraftForPayment(input: { actor: Actor; ipAddress?: string | null }): Promise<WizardView> {
  const { actor } = input;
  const open = await findOpenDraft(actor.id);
  if (!open) {
    const current = await getWizardDraft(actor);
    if (current?.shop) return current;
    throw notFound("Registration in progress");
  }
  const view = await toWizardView(open);
  if (view.nextStep !== "REVIEW") {
    throw conflict("Please finish every step before payment.", { reason: "STEP_OPEN", nextStep: view.nextStep });
  }
  // Checked again here: the shop type may have been changed after the FSSAI step.
  if (view.foodShop && !view.fssai.done) {
    throw validationFailed("A shop that sells food needs an FSSAI licence or registration.", { fields: { fssai: "Required for a food shop." } });
  }
  const details = view.details!;
  const checks = await loadChecks(open.id);
  const row = (t: DraftCheckDocType) => checks.find((c) => c.docType === t);
  const referralCode = await assertRegistrationReferralCode(details.referralCode);
  const rule = await getRule("sellerVerification");
  const imports = registrationChecks(open, checks, details, rule.nameMatchAutoApprove);
  const panRecordName = str(open.panRecord?.name);
  const stamp = open.updatedAt.getTime();

  const onSaved = async (tx: DbClient, shop: Shop) => {
    const [draft] = await tx.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, open.id)).for("update");
    // Changed in another tab after this submission read it: nothing is created.
    if (!draft || draft.status !== "OPEN" || draft.updatedAt.getTime() !== stamp) {
      throw conflict("Your registration changed while it was being submitted. Please check it and try again.", { reason: "DRAFT_CHANGED" });
    }
    // Deferrals first, so the onboarding stage sees them when the verification rows arrive.
    const deferred: ("GSTIN" | "SHOP_ACT")[] = [];
    if (row("SHOP_ACT")?.status !== "VERIFIED") deferred.push("SHOP_ACT");
    if (draft.route === "PAN_ONLY") deferred.push("GSTIN");
    for (const docType of deferred) {
      // The only unique key is (shop_id, doc_type).
      await tx.insert(shopDeferredDocumentReviews).values({ shopId: shop.id, docType, reason: REVIEW_AFTER_GO_LIVE }).onConflictDoNothing();
    }
    for (const check of imports) await importRegistrationCheck(tx, shop.id, check, actor, draft.id);
    if (draft.route === "PAN_ONLY") {
      await importRegistrationGstDeclaration(
        tx,
        shop.id,
        { declaredAt: draft.noGstDeclaredAt ?? new Date(), version: draft.noGstDeclarationVersion ?? GST_DECLARATION_VERSION },
        actor,
        draft.id,
      );
    }
    await tx
      .update(shopRegistrationDrafts)
      .set({ status: "SUBMITTED", shopId: shop.id, submittedAt: new Date(), updatedAt: new Date() })
      .where(eq(shopRegistrationDrafts.id, draft.id));
  };

  const gstin = open.route === "GSTIN" && open.gstinEncrypted ? decryptSecret(open.gstinEncrypted) : null;
  let shop: Awaited<ReturnType<typeof registerShop>>;
  try {
    shop = await registerShop(
      {
        name: details.name,
        ownerName: details.ownerName,
        phone: details.phone,
        email: details.email,
        addressLine1: details.addressLine1,
        addressLine2: details.addressLine2,
        area: details.area,
        city: details.city,
        state: details.state,
        pincode: details.pincode,
        landmark: details.landmark,
        latitude: open.latitude,
        longitude: open.longitude,
        shopType: details.shopType,
        categoryIds: details.categoryIds,
        annualTurnoverRupees: details.annualTurnoverRupees,
        couponCode: details.couponCode,
        gstin,
        panNumber: open.panEncrypted ? decryptSecret(open.panEncrypted) : null,
        panHolderName: panRecordName ?? details.ownerName,
        udyamNumber: plain(row("UDYAM"), open.hasUdyam === true),
        shopActNumber: plain(row("SHOP_ACT")),
      },
      actor,
      { onSaved },
    );
  } catch (error) {
    // A second tap (another tab) while the first created the shop: the owner lock made it wait, and
    // registerShop then refuses it as "already waiting". The first one's result is the answer.
    const current = await getWizardDraft(actor);
    if (current?.shop && current.status !== "OPEN") return current;
    throw error;
  }

  // After the commit, as POST /api/shops does: referral code and dealer attribution never block the registration.
  if (referralCode) await attributeRegistrationReferral(shop, referralCode, actor);
  await recordShopAttributionSafely(shop.id, actor, { employeeText: details.employeeId ?? null });
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_REGISTRATION_DRAFT_SUBMITTED,
    entityType: "shop_registration_draft",
    entityId: open.id,
    ipAddress: input.ipAddress ?? null,
    newValue: { shopId: shop.id, route: open.route, documents: imports.map((c) => ({ docType: c.docType, number: c.numberMasked, status: c.status })) },
  });
  // Nothing to pay (a full coupon): the approval runs now instead of on the payment webhook.
  if (registrationFeeDue(shop) === 0) {
    await autoApproveShopIfReady(shop.id).catch((error) => console.error("[registration-wizard] auto-approval check failed", shop.id, error));
  }
  const [final] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, open.id));
  return toWizardView(final);
}
