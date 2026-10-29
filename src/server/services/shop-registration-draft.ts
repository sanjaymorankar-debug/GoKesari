/**
 * Onboarding wizard, step 1 (docs/shop-onboarding-wizard-2026-10): the owner's
 * registration in progress, before the shop row exists.
 *
 *   GSTIN route  — the owner types the GSTIN; the government record gives the
 *                  shop / entity name, legal name and address, and the PAN
 *                  inside the GSTIN is then checked with the government in the
 *                  background (owner decision, 28 Oct 2026: a separate PAN
 *                  record, never copied from the GST answer). The PAN holder's
 *                  name must match the GST legal or trade name.
 *   PAN_ONLY     — "I don't have a GSTIN": the owner types the PAN and signs
 *                  the "not GST-registered" declaration, which an admin
 *                  reviews once the shop exists (as today).
 *
 * Same safeguards as seller-verification.ts: local format check before any
 * paid call; explicit consent; the draft row claimed under a lock, with a
 * verified number served from the stored result and an identical check in
 * flight joined; a per-draft hourly limit; vendor calls outside every
 * transaction, with a result written only if no newer check claimed the row.
 * A vendor outage leaves the check PENDING and the owner may continue — the
 * shop cannot be approved until it is verified.
 *
 * Full numbers exist only in memory and as ciphertext; views carry the masked
 * form only.
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";

import { GST_DECLARATION_VERSION, SELLER_VERIFICATION_CONSENT_VERSION } from "@/lib/kyc/consent";
import { parseSellerDocNumber, PAN_HOLDER_TYPES, type ParsedDocNumber, type PanHolderType } from "@/lib/kyc/doc-formats";
import { bestNameMatch } from "@/lib/kyc/name-match";
import { AppError, conflict, notFound, validationFailed } from "@/lib/errors";
import { docBlindIndex, encryptSecret } from "@/lib/pan-crypto";
import { db, type DbClient } from "@/server/db";
import { isUniqueViolation } from "@/server/db/split/upsert";
import {
  shopRegistrationDrafts,
  shops,
  users,
  type DraftCheckStatus,
  type ShopRegistrationDraft,
  type UserRole,
} from "@/server/db/schema";
import { verifyDocument, type SourceRecord, type VerifyDocumentResult } from "@/server/kyc";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { getRule } from "./settings";

export interface Actor {
  id: string;
  role: UserRole;
}

/** A second identical submission within this window rides on the first instead of paying again. */
export const IN_FLIGHT_WINDOW_MS = 30_000;
const HOUR_MS = 3_600_000;

/** Statuses that let the owner go on to the next step (an outage or a review is settled later). */
export const CAN_CONTINUE: readonly DraftCheckStatus[] = ["VERIFIED", "PENDING", "MANUAL_REVIEW"];

const MESSAGES: Record<string, string> = {
  not_found_at_source: "This number was not found in the government record. Please check it and try again.",
  document_cancelled: "The government record shows this GSTIN as cancelled.",
  document_inactive: "The government record shows this number as inactive.",
  document_suspended: "The government record shows this GSTIN as suspended.",
  document_expired: "The government record shows this number as expired.",
  gstin_pan_mismatch: "The government record links this GSTIN to a different PAN. We'll check it by hand.",
  name_not_returned: "The government record gave no name. We'll check it by hand.",
  name_mismatch: "The name on the PAN does not match the name on the GST record. We'll check it by hand.",
  // Step 2: Udyam, FSSAI, Shop Act.
  vendor_unsupported: "This number can't be checked online. You can carry on — our team will check it.",
  expiry_not_returned: "The government record gave no expiry date. We'll check it by hand.",
  address_mismatch: "The PIN code on the government record is not the shop's. We'll check it by hand.",
};
const PENDING_MESSAGE = "The government service is not answering right now. You can carry on — we'll keep checking.";
const REVIEW_MESSAGE = "We couldn't confirm this automatically. You can carry on — our team will check it.";

/* ------------------------------------------------------------------ views */

export interface DraftCheckView {
  numberMasked: string | null;
  status: DraftCheckStatus;
  errorCode: string | null;
  /** What to tell the owner when the check is not VERIFIED. */
  message: string | null;
}

export interface ShopRegistrationDraftView {
  id: string;
  route: "GSTIN" | "PAN_ONLY" | null;
  gstin: DraftCheckView | null;
  pan: (DraftCheckView & { holderType: string | null; nameMatchScore: number | null }) | null;
  noGstDeclared: boolean;
  /** Filled from the government records, for the shop details step. */
  prefill: {
    shopName: string | null;
    legalName: string | null;
    tradeName: string | null;
    ownerName: string | null;
    constitution: string | null;
    address: string | null;
    stateCode: string | null;
    pincode: string | null;
  };
  /** True when the owner may go on to the shop details step. */
  canContinue: boolean;
}

export function message(status: DraftCheckStatus, errorCode: string | null): string | null {
  if (status === "VERIFIED" || status === "NOT_SUBMITTED") return null;
  if (status === "PENDING") return PENDING_MESSAGE;
  const known = errorCode ? MESSAGES[errorCode] : undefined;
  return known ?? (status === "MANUAL_REVIEW" ? REVIEW_MESSAGE : "We couldn't verify this number. Please check it and try again.");
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function toDraftView(draft: ShopRegistrationDraft): ShopRegistrationDraftView {
  const gst = draft.gstRecord ?? {};
  const pan = draft.panRecord ?? {};
  const gstVerified = draft.gstStatus === "VERIFIED";
  const legalName = gstVerified ? str(gst.legalName) : null;
  const tradeName = gstVerified ? str(gst.tradeName) : null;
  const panName = draft.panStatus === "VERIFIED" || draft.panStatus === "MANUAL_REVIEW" ? str(pan.name) : null;
  const holderLetter = str(pan.holderType);

  const gstinView = draft.gstinMasked
    ? { numberMasked: draft.gstinMasked, status: draft.gstStatus, errorCode: draft.gstErrorCode, message: message(draft.gstStatus, draft.gstErrorCode) }
    : null;
  const panView = draft.panMasked
    ? {
        numberMasked: draft.panMasked,
        status: draft.panStatus,
        errorCode: draft.panErrorCode,
        message: message(draft.panStatus, draft.panErrorCode),
        holderType: holderLetter && holderLetter in PAN_HOLDER_TYPES ? PAN_HOLDER_TYPES[holderLetter as PanHolderType] : null,
        nameMatchScore: draft.panNameMatchScore,
      }
    : null;

  let canContinue = false;
  if (draft.route === "GSTIN") {
    // The PAN is checked only after a verified GSTIN; an outage or a review leaves it for later.
    canContinue =
      CAN_CONTINUE.includes(draft.gstStatus) &&
      (draft.panStatus === "NOT_SUBMITTED" ? draft.gstStatus !== "VERIFIED" : CAN_CONTINUE.includes(draft.panStatus));
  } else if (draft.route === "PAN_ONLY") {
    canContinue = CAN_CONTINUE.includes(draft.panStatus) && draft.noGstDeclaredAt !== null;
  }

  return {
    id: draft.id,
    route: draft.route,
    gstin: gstinView,
    pan: panView,
    noGstDeclared: draft.noGstDeclaredAt !== null,
    prefill: {
      // The shop's name as customers know it: the GST trade name, else the legal name.
      shopName: tradeName ?? legalName,
      legalName,
      tradeName,
      // A proprietor's PAN is the person's; a firm's or company's is the business's.
      ownerName: holderLetter === "P" ? panName : null,
      constitution: gstVerified ? str(gst.constitution) : null,
      address: gstVerified ? str(gst.address) : null,
      stateCode: gstVerified ? str(gst.stateCode) : null,
      pincode: gstVerified ? str(gst.pincode) : null,
    },
    canContinue,
  };
}

/* --------------------------------------------------------------- reading */

export async function findOpenDraft(ownerId: string): Promise<ShopRegistrationDraft | undefined> {
  const [draft] = await db
    .select()
    .from(shopRegistrationDrafts)
    .where(and(eq(shopRegistrationDrafts.ownerId, ownerId), eq(shopRegistrationDrafts.status, "OPEN")))
    .limit(1);
  return draft;
}

/** The owner's registration in progress, or null — the wizard resumes from it. */
export async function getOpenDraft(actor: Actor): Promise<ShopRegistrationDraftView | null> {
  const draft = await findOpenDraft(actor.id);
  return draft ? toDraftView(draft) : null;
}

/* ------------------------------------------------------- shared helpers */

/** The owner is a platform user (no foreign key across the split): checked here. */
export async function assertOwnerExists(ownerId: string): Promise<void> {
  const owner = await db.query.users.findFirst({ where: eq(users.id, ownerId), columns: { id: true } });
  if (!owner) throw notFound("User");
}

/** A live shop already holds this GSTIN: the owner is told before any paid call. */
async function assertGstinFree(gstin: string): Promise<void> {
  const [taken] = await db
    .select({ id: shops.id })
    .from(shops)
    .where(and(eq(shops.gstin, gstin), isNull(shops.deletedAt), ne(shops.status, "REJECTED")))
    .limit(1);
  if (taken) {
    throw conflict("A shop with this GSTIN is already registered on GoKesari. If it is yours, sign in with the account that registered it, or contact support.", {
      reason: "DUPLICATE_SHOP",
    });
  }
}

/**
 * The owner's OPEN draft, created if missing, locked for this transaction.
 * The advisory lock serialises two tabs of one owner creating it at once.
 */
async function lockOpenDraft(tx: DbClient, ownerId: string): Promise<ShopRegistrationDraft> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shop-registration-draft:${ownerId}`}, 0))`);
  const lockOpen = () =>
    tx
      .select()
      .from(shopRegistrationDrafts)
      .where(and(eq(shopRegistrationDrafts.ownerId, ownerId), eq(shopRegistrationDrafts.status, "OPEN")))
      .for("update");
  const [existing] = await lockOpen();
  if (existing) return existing;
  try {
    await tx.insert(shopRegistrationDrafts).values({ ownerId });
  } catch (error) {
    // Only reachable if a writer bypassed the lock; the other draft wins.
    if (!isUniqueViolation(error)) throw error;
  }
  const [created] = await lockOpen();
  return created;
}

/** The per-draft hourly limit on paid checks the owner can start. */
export async function countCheck(tx: DbClient, draft: ShopRegistrationDraft, now: Date) {
  const rule = await getRule("sellerVerification");
  const windowOpen = draft.checkWindowStartedAt && now.getTime() - draft.checkWindowStartedAt.getTime() < HOUR_MS;
  const used = windowOpen ? draft.checksInWindow : 0;
  if (used >= rule.maxChecksPerShopPerHour) {
    throw new AppError("RATE_LIMITED", "Too many checks in the last hour. Please try again later.");
  }
  return { checkWindowStartedAt: windowOpen ? draft.checkWindowStartedAt : now, checksInWindow: used + 1 };
}

/** What is kept of the GST record. The PAN it names is never stored — only whether it is the GSTIN's own. */
function recordFields(record: SourceRecord | null, doc: ParsedDocNumber) {
  if (!record) return {};
  return {
    docStatus: record.docStatus,
    panLinked: record.linkedPan && doc.gstEmbeddedPan ? record.linkedPan.toUpperCase() === doc.gstEmbeddedPan : null,
    legalName: record.name ?? null,
    tradeName: record.tradeName ?? null,
    constitution: record.entityType ?? null,
    stateCode: record.stateCode ?? null,
    pincode: record.pincode ?? null,
    address: record.address ?? null,
  };
}

/** The GST answer as a draft status: active, has a name, and belongs to the PAN inside the GSTIN. */
function judgeGst(result: VerifyDocumentResult, doc: ParsedDocNumber): { status: DraftCheckStatus; errorCode: string | null } {
  if (result.status !== "VERIFIED") return { status: result.status, errorCode: result.errorCode };
  const record = result.record!;
  if (record.linkedPan && doc.gstEmbeddedPan && record.linkedPan.toUpperCase() !== doc.gstEmbeddedPan) {
    return { status: "MANUAL_REVIEW", errorCode: "gstin_pan_mismatch" };
  }
  if (!record.name && !record.tradeName) return { status: "MANUAL_REVIEW", errorCode: "name_not_returned" };
  return { status: "VERIFIED", errorCode: null };
}

/** The PAN answer: active and, on the GSTIN route, the holder's name is the GST legal or trade name. */
function judgePan(
  result: VerifyDocumentResult,
  gstNames: (string | null)[] | null,
  threshold: number,
): { status: DraftCheckStatus; errorCode: string | null; score: number | null } {
  if (result.status !== "VERIFIED") return { status: result.status, errorCode: result.errorCode, score: null };
  const name = result.record?.name ?? null;
  if (!name) return { status: "MANUAL_REVIEW", errorCode: "name_not_returned", score: null };
  if (!gstNames) return { status: "VERIFIED", errorCode: null, score: null };
  const score = Math.max(bestNameMatch([name], gstNames).score, result.record?.vendorNameMatchScore ?? 0);
  return score >= threshold ? { status: "VERIFIED", errorCode: null, score } : { status: "MANUAL_REVIEW", errorCode: "name_mismatch", score };
}

/* ------------------------------------------------------------ PAN check */

/** Claims the draft's PAN check, calls the vendor, and stores the result. */
async function runPanCheck(
  draftId: string,
  doc: ParsedDocNumber,
  gstNames: (string | null)[] | null,
): Promise<void> {
  const panHash = docBlindIndex("PAN", doc.normalized);
  const claimed = await db.transaction(async (tx) => {
    const [draft] = await tx.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, draftId)).for("update");
    if (!draft || draft.status !== "OPEN") return null;
    if (draft.panHash === panHash && draft.panStatus === "VERIFIED") return null;
    const key = `${draft.id}:pan:${Date.now()}`;
    await tx
      .update(shopRegistrationDrafts)
      .set({
        panEncrypted: encryptSecret(doc.normalized),
        panMasked: doc.masked,
        panHash,
        panStatus: "PENDING",
        ...(draft.panHash === panHash ? {} : { panRecord: {}, panNameMatchScore: null, panVerifiedAt: null }),
        panErrorCode: null,
        panIdempotencyKey: key,
        panCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(shopRegistrationDrafts.id, draft.id));
    return key;
  });
  if (!claimed) return;

  const rule = await getRule("sellerVerification");
  const legalName = gstNames?.[0] ?? undefined;
  const result = await verifyDocument("PAN", doc.normalized, { nameToMatch: legalName }, claimed);
  const judged = judgePan(result, gstNames, rule.nameMatchAutoApprove);
  const now = new Date();
  await db
    .update(shopRegistrationDrafts)
    .set({
      panStatus: judged.status,
      panErrorCode: judged.errorCode,
      panRecord: result.record
        ? { docStatus: result.record.docStatus, name: result.record.name ?? null, holderType: doc.panHolderType ?? null }
        : { holderType: doc.panHolderType ?? null },
      panNameMatchScore: judged.score,
      panProviderId: result.providerId,
      panProviderRef: result.rawRef,
      panVerifiedAt: judged.status === "VERIFIED" ? now : null,
      updatedAt: now,
    })
    // Only if no newer check claimed the row while the vendor was answering.
    .where(and(eq(shopRegistrationDrafts.id, draftId), eq(shopRegistrationDrafts.panIdempotencyKey, claimed)));
}

/* ------------------------------------------------------- GSTIN (route 1) */

export interface SubmitDraftGstinInput {
  gstin: string;
  /** Must be true: the owner agreed to the government checks. */
  consentGiven: boolean;
  actor: Actor;
  ipAddress?: string | null;
}

/**
 * Checks the GSTIN with the government source and, once it is verified, the
 * PAN inside it — the owner types only the GSTIN. The GST record fills the
 * draft's shop name, legal name and address.
 */
export async function submitDraftGstin(input: SubmitDraftGstinInput): Promise<ShopRegistrationDraftView> {
  const parsed = parseSellerDocNumber("GSTIN", input.gstin);
  if (!parsed.ok) throw validationFailed("Please check the highlighted fields.", { fields: { gstin: parsed.error } });
  if (!input.consentGiven) throw validationFailed("Please agree to the verification consent before we check this number.");
  const doc = parsed.value;
  const { actor } = input;
  await assertOwnerExists(actor.id);
  await assertGstinFree(doc.normalized);

  const gstinHash = docBlindIndex("GSTIN", doc.normalized);
  const now = new Date();
  type Claim = { kind: "done"; draftId: string } | { kind: "call"; draftId: string; key: string };
  const claim = await db.transaction(async (tx): Promise<Claim> => {
    const draft = await lockOpenDraft(tx, actor.id);
    const sameNumber = draft.gstinHash === gstinHash && draft.route === "GSTIN";
    if (sameNumber && draft.gstStatus === "VERIFIED" && draft.panStatus === "VERIFIED") return { kind: "done", draftId: draft.id };
    if (sameNumber && draft.gstStatus === "PENDING" && draft.gstCheckedAt && now.getTime() - draft.gstCheckedAt.getTime() < IN_FLIGHT_WINDOW_MS) {
      return { kind: "done", draftId: draft.id };
    }
    const counted = await countCheck(tx, draft, now);
    // GSTIN verified, PAN still open (an outage, a review): only the PAN is checked again.
    if (sameNumber && draft.gstStatus === "VERIFIED") {
      await tx.update(shopRegistrationDrafts).set({ ...counted, updatedAt: now }).where(eq(shopRegistrationDrafts.id, draft.id));
      return { kind: "call", draftId: draft.id, key: "" };
    }

    const key = `${draft.id}:gst:${now.getTime()}`;
    await tx
      .update(shopRegistrationDrafts)
      .set({
        route: "GSTIN",
        gstinEncrypted: encryptSecret(doc.normalized),
        gstinMasked: doc.masked,
        gstinHash,
        gstStatus: "PENDING",
        gstErrorCode: null,
        gstIdempotencyKey: key,
        gstCheckedAt: now,
        // A new GSTIN invalidates everything learned from the old one, PAN included.
        ...(sameNumber
          ? {}
          : {
              gstRecord: {},
              gstVerifiedAt: null,
              panEncrypted: null,
              panMasked: null,
              panHash: null,
              panStatus: "NOT_SUBMITTED" as const,
              panRecord: {},
              panNameMatchScore: null,
              panErrorCode: null,
              panIdempotencyKey: null,
              panVerifiedAt: null,
            }),
        noGstDeclaredAt: null,
        noGstDeclarationVersion: null,
        consentGivenAt: now,
        consentVersion: SELLER_VERIFICATION_CONSENT_VERSION,
        ...counted,
        updatedAt: now,
      })
      .where(eq(shopRegistrationDrafts.id, draft.id));
    return { kind: "call", draftId: draft.id, key };
  });

  if (claim.kind === "call" && claim.key) {
    const result = await verifyDocument("GSTIN", doc.normalized, {}, claim.key);
    const judged = judgeGst(result, doc);
    const checkedAt = new Date();
    await db
      .update(shopRegistrationDrafts)
      .set({
        gstStatus: judged.status,
        gstErrorCode: judged.errorCode,
        gstRecord: recordFields(result.record, doc),
        gstProviderId: result.providerId,
        gstProviderRef: result.rawRef,
        gstVerifiedAt: judged.status === "VERIFIED" ? checkedAt : null,
        updatedAt: checkedAt,
      })
      .where(and(eq(shopRegistrationDrafts.id, claim.draftId), eq(shopRegistrationDrafts.gstIdempotencyKey, claim.key)));
  }

  if (claim.kind === "call") {
    const [draft] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, claim.draftId));
    // The silent PAN check runs only for a GSTIN the government confirmed.
    if (draft?.gstStatus === "VERIFIED" && draft.gstinHash === gstinHash && doc.gstEmbeddedPan) {
      const pan = parseSellerDocNumber("PAN", doc.gstEmbeddedPan);
      if (pan.ok) {
        const record = draft.gstRecord ?? {};
        await runPanCheck(draft.id, pan.value, [str(record.legalName), str(record.tradeName)]);
      }
    }
  }

  const [final] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, claim.draftId));
  if (claim.kind === "call") {
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SHOP_REGISTRATION_DRAFT_CHECKED,
      entityType: "shop_registration_draft",
      entityId: final.id,
      ipAddress: input.ipAddress ?? null,
      newValue: { route: "GSTIN", gstin: final.gstinMasked, gstStatus: final.gstStatus, pan: final.panMasked, panStatus: final.panStatus },
    });
  }
  return toDraftView(final);
}

/* ---------------------------------------------------- PAN only (route 2) */

export interface SubmitDraftPanInput {
  pan: string;
  /** "This shop is not registered under GST" — required on this route. */
  declarationAccepted: boolean;
  consentGiven: boolean;
  actor: Actor;
  ipAddress?: string | null;
}

/** No GSTIN: the PAN alone is checked, and the owner signs the "not GST-registered" declaration. */
export async function submitDraftPan(input: SubmitDraftPanInput): Promise<ShopRegistrationDraftView> {
  const parsed = parseSellerDocNumber("PAN", input.pan);
  if (!parsed.ok) throw validationFailed("Please check the highlighted fields.", { fields: { pan: parsed.error } });
  if (!input.declarationAccepted) {
    throw validationFailed("Please confirm that the shop is not registered under GST, or enter its GSTIN instead.");
  }
  if (!input.consentGiven) throw validationFailed("Please agree to the verification consent before we check this number.");
  const doc = parsed.value;
  const { actor } = input;
  await assertOwnerExists(actor.id);

  const panHash = docBlindIndex("PAN", doc.normalized);
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const draft = await lockOpenDraft(tx, actor.id);
    const samePan = draft.route === "PAN_ONLY" && draft.panHash === panHash;
    const counted = samePan && draft.panStatus === "VERIFIED" ? null : await countCheck(tx, draft, now);
    await tx
      .update(shopRegistrationDrafts)
      .set({
        route: "PAN_ONLY",
        // Switching from the GSTIN route: the GSTIN and everything it filled in go.
        gstinEncrypted: null,
        gstinMasked: null,
        gstinHash: null,
        gstStatus: "NOT_SUBMITTED",
        gstRecord: {},
        gstProviderId: null,
        gstProviderRef: null,
        gstErrorCode: null,
        gstIdempotencyKey: null,
        gstVerifiedAt: null,
        noGstDeclaredAt: now,
        noGstDeclarationVersion: GST_DECLARATION_VERSION,
        consentGivenAt: now,
        consentVersion: SELLER_VERIFICATION_CONSENT_VERSION,
        ...(counted ?? {}),
        // The PAN of a GSTIN is not this route's PAN: a check stored under the other route is redone.
        ...(samePan ? {} : { panHash: null, panStatus: "NOT_SUBMITTED" as const }),
        updatedAt: now,
      })
      .where(eq(shopRegistrationDrafts.id, draft.id));
    return { draftId: draft.id, called: counted !== null };
  });

  await runPanCheck(result.draftId, doc, null);
  const [final] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, result.draftId));
  if (result.called) {
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SHOP_REGISTRATION_DRAFT_CHECKED,
      entityType: "shop_registration_draft",
      entityId: final.id,
      ipAddress: input.ipAddress ?? null,
      newValue: { route: "PAN_ONLY", pan: final.panMasked, panStatus: final.panStatus, noGstDeclared: true },
    });
  }
  return toDraftView(final);
}
