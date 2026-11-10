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
 * Owner brief 08-Nov-2026 (docs/shop-onboarding-identity-first-2026-11): the
 * owner goes on only once the GSTIN — or, without one, the PAN — is VERIFIED;
 * an outage or a review keeps them on this step to try again. A PAN on the
 * GSTIN route (checked in the background) never holds them up.
 *
 * Full numbers exist only in memory and as ciphertext; views carry the masked
 * form only.
 */
import { and, eq, isNull, lt, ne, sql } from "drizzle-orm";

import { GST_DECLARATION_VERSION, SELLER_VERIFICATION_CONSENT_VERSION } from "@/lib/kyc/consent";
import { parseSellerDocNumber, PAN_HOLDER_TYPES, type ParsedDocNumber, type PanHolderType } from "@/lib/kyc/doc-formats";
import { gstState } from "@/lib/gst-states";
import { bestNameMatch } from "@/lib/kyc/name-match";
import { AppError, conflict, notFound, validationFailed } from "@/lib/errors";
import { docBlindIndex, encryptSecret, panBlindIndex } from "@/lib/pan-crypto";
import { db, type DbClient } from "@/server/db";
import { isUniqueViolation } from "@/server/db/upsert";
import {
  shopRegistrationDrafts,
  shops,
  users,
  type DraftCheckStatus,
  type ShopRegistrationDraft,
  type UserRole,
} from "@/server/db/schema";
import { verifyDocument, type SourceRecord, type VerifyDocumentResult } from "@/server/kyc";
import { gstinHeldByOtherOwner } from "./shop-duplicates";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { registrationFeeDue } from "./registration-fee-payment";
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
  vendor_unsupported: "This number can't be checked online. You can carry on — our team will review it.",
  expiry_not_returned: "The government record gave no expiry date. We'll check it by hand.",
  address_mismatch: "The PIN code on the government record is not the shop's. We'll check it by hand.",
};
const PENDING_MESSAGE = "The government service is not answering right now. You can carry on — we'll keep checking.";
const REVIEW_MESSAGE = "We couldn't confirm this automatically. You can carry on — our team will check it.";
/** The GSTIN, or the PAN without one, must be verified before the owner goes on (owner brief 08-Nov-2026). */
const IDENTITY_MESSAGES: Record<string, string> = {
  gstin_pan_mismatch: "The government record links this GSTIN to a different PAN. Please check the number, or enter your PAN instead.",
  name_not_returned: "The government record gave no name for this number, so we can't verify it. Please check the number and try again.",
};
const IDENTITY_PENDING = "The government service is not answering right now. Please try again in a few minutes.";
const IDENTITY_REVIEW = "We couldn't verify this number automatically. Please check it and try again.";

/** The message for the GSTIN, or the PAN on the no-GSTIN route: nothing but VERIFIED lets the owner on. */
function identityMessage(status: DraftCheckStatus, errorCode: string | null): string | null {
  if (status === "PENDING") return IDENTITY_PENDING;
  if (status === "MANUAL_REVIEW") return (errorCode ? IDENTITY_MESSAGES[errorCode] : undefined) ?? IDENTITY_REVIEW;
  return message(status, errorCode);
}

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
    /** Onboarding Phase B (G5): the state's name and the city, read from the GST record. */
    state: string | null;
    city: string | null;
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

/**
 * The city in a GST principal-place address ("12, MG Road, Shivaji Nagar, Pune, Maharashtra, 411001"):
 * the last part before the state name and PIN. Null when it cannot be told apart.
 */
export function cityFromAddress(address: string | null, stateCode: string | null, pincode: string | null): string | null {
  if (!address) return null;
  const state = gstState(stateCode)?.name.toUpperCase() ?? null;
  const parts = address
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !/^\d{6}$/.test(p) && p !== pincode && p.toUpperCase() !== state && !/^\d+$/.test(p));
  const last = parts.length > 1 ? parts[parts.length - 1] : null;
  return last && /^[A-Za-z][A-Za-z .'-]{1,59}$/.test(last) ? last : null;
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

  const panOnly = draft.route === "PAN_ONLY";
  const gstinView = draft.gstinMasked
    ? { numberMasked: draft.gstinMasked, status: draft.gstStatus, errorCode: draft.gstErrorCode, message: identityMessage(draft.gstStatus, draft.gstErrorCode) }
    : null;
  const panView = draft.panMasked
    ? {
        numberMasked: draft.panMasked,
        status: draft.panStatus,
        errorCode: draft.panErrorCode,
        message: panOnly ? identityMessage(draft.panStatus, draft.panErrorCode) : message(draft.panStatus, draft.panErrorCode),
        holderType: holderLetter && holderLetter in PAN_HOLDER_TYPES ? PAN_HOLDER_TYPES[holderLetter as PanHolderType] : null,
        nameMatchScore: draft.panNameMatchScore,
      }
    : null;

  // Owner brief 08-Nov-2026: verified, nothing less. The GSTIN's own PAN is checked in the background
  // and never holds the owner up.
  let canContinue = false;
  // A PAN the government refused (inactive) still stops the owner, as before.
  if (draft.route === "GSTIN") canContinue = gstVerified && draft.panStatus !== "FAILED" && draft.panStatus !== "EXPIRED";
  else if (panOnly) canContinue = draft.panStatus === "VERIFIED" && draft.noGstDeclaredAt !== null;
  // No GSTIN: the PAN record's own name and address, where the source gives them.
  const panAddress = panOnly && draft.panStatus === "VERIFIED" ? str(pan.address) : null;
  const panPincode = panOnly && draft.panStatus === "VERIFIED" ? str(pan.pincode) : null;

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
      address: gstVerified ? str(gst.address) : panAddress,
      stateCode: gstVerified ? str(gst.stateCode) : null,
      state: gstVerified ? (gstState(str(gst.stateCode))?.name ?? null) : null,
      city: gstVerified ? cityFromAddress(str(gst.address), str(gst.stateCode), str(gst.pincode)) : cityFromAddress(panAddress, null, panPincode),
      pincode: gstVerified ? str(gst.pincode) : panPincode,
    },
    canContinue,
  };
}

/* --------------------------------------------------------------- reading */

/**
 * Owner brief 08-Nov-2026 (Flow 2): an abandoned registration is not resumed — the owner starts
 * again at the GST / PAN screen. Abandoned = no step for this long: past both reminders (24 h and
 * 72 h, scheduled-notices.ts), which still invite the owner back to the same registration.
 */
export const ABANDONED_AFTER_MS = 7 * 24 * HOUR_MS;

/** Marks the owner's OPEN registration ABANDONED when it has been left for ABANDONED_AFTER_MS. */
export async function discardAbandonedDraft(ownerId: string, client: DbClient = db, now: Date = new Date()): Promise<void> {
  await client
    .update(shopRegistrationDrafts)
    .set({ status: "ABANDONED", updatedAt: now })
    .where(
      and(
        eq(shopRegistrationDrafts.ownerId, ownerId),
        eq(shopRegistrationDrafts.status, "OPEN"),
        lt(shopRegistrationDrafts.updatedAt, new Date(now.getTime() - ABANDONED_AFTER_MS)),
      ),
    );
}

export async function findOpenDraft(ownerId: string): Promise<ShopRegistrationDraft | undefined> {
  await discardAbandonedDraft(ownerId);
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

/** What the owner is told about the shop already registered with this number (owner brief 08-Nov-2026). */
const HELD_STATUS: Record<string, string> = {
  APPROVED: "It is live on GoKesari.",
  PENDING_APPROVAL: "It is waiting for its registration fee or admin approval.",
  SUSPENDED: "It is registered but not active at the moment.",
  INACTIVE: "It is registered but not active at the moment.",
};

/** A live shop already holds this GSTIN: the owner is told, with that shop's status, before any paid call. */
async function assertGstinFree(gstin: string, ownerId: string): Promise<void> {
  // Owner decision, 29 Oct 2026: the same owner may open another branch on its GSTIN; another account may not.
  const held = await gstinHeldByOtherOwner(gstin, ownerId);
  if (held) {
    const [shop] = await db.select({ status: shops.status }).from(shops).where(eq(shops.id, held.shopId));
    const status = shop ? (HELD_STATUS[shop.status] ?? "") : "";
    throw conflict(
      `A shop with this GSTIN is already registered on GoKesari by another account. ${status} If it is yours, sign in with the account that registered it, or contact support.`.replace(/\s+/g, " "),
      { reason: "DUPLICATE_SHOP", shopStatus: shop?.status ?? null, fields: { gstin: "This GSTIN is already registered." } },
    );
  }
}

/**
 * No GSTIN: another account's live shop with this PAN is reported with its status before any
 * paid call — the same rule as the GSTIN (the same owner may open another branch).
 */
async function assertPanFree(pan: string, actor: Actor): Promise<void> {
  const [held] = await db
    .select({ status: shops.status })
    .from(shops)
    .where(and(eq(shops.panHash, panBlindIndex(pan)), isNull(shops.deletedAt), ne(shops.status, "REJECTED"), ne(shops.ownerId, actor.id)))
    .limit(1);
  if (held) {
    throw conflict(
      `A shop with this PAN is already registered on GoKesari by another account. ${HELD_STATUS[held.status] ?? ""} If it is yours, sign in with the account that registered it, or contact support.`.replace(/\s+/g, " "),
      { reason: "DUPLICATE_SHOP", shopStatus: held.status, fields: { pan: "This PAN is already registered." } },
    );
  }
}

/** The owner's shop still waiting for its fee or for approval, if any: one registration at a time (owner request, 26 Oct 2026). */
export async function waitingRegistration(ownerId: string): Promise<{ id: string; name: string; feeDuePaise: number } | null> {
  const [shop] = await db
    .select()
    .from(shops)
    .where(and(eq(shops.ownerId, ownerId), eq(shops.status, "PENDING_APPROVAL"), isNull(shops.deletedAt)))
    .limit(1);
  return shop ? { id: shop.id, name: shop.name, feeDuePaise: registrationFeeDue(shop) } : null;
}

/** What the owner is told about that shop; the same words before the first screen and on any later step. */
export function waitingRegistrationMessage(shop: { name: string; feeDuePaise: number }): string {
  return shop.feeDuePaise > 0
    ? `${shop.name} still has its registration fee to pay. Please pay it first — you can add another shop after that.`
    : `${shop.name} is already waiting for approval. You'll be notified once it's reviewed — you can add another shop after that.`;
}

/** registerShop() refuses a second registration at the very end; this stops it before any screen is filled in or any paid check is made. */
export async function assertNoWaitingRegistration(ownerId: string): Promise<void> {
  const waiting = await waitingRegistration(ownerId);
  if (waiting) throw conflict(waitingRegistrationMessage(waiting), { reason: "REGISTRATION_PENDING", shopId: waiting.id });
}

/**
 * The owner's OPEN draft, created if missing, locked for this transaction.
 * The advisory lock serialises two tabs of one owner creating it at once.
 */
export async function lockOpenDraft(tx: DbClient, ownerId: string): Promise<ShopRegistrationDraft> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shop-registration-draft:${ownerId}`}, 0))`);
  await discardAbandonedDraft(ownerId, tx);
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
        ? {
            docStatus: result.record.docStatus,
            name: result.record.name ?? null,
            holderType: doc.panHolderType ?? null,
            // Owner brief 08-Nov-2026: where the PAN source gives an address, it fills the no-GSTIN route's address.
            address: result.record.address ?? null,
            pincode: result.record.pincode ?? null,
          }
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
  await assertNoWaitingRegistration(actor.id);
  await assertGstinFree(doc.normalized, actor.id);

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
  await assertNoWaitingRegistration(actor.id);
  await assertPanFree(doc.normalized, actor);

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
