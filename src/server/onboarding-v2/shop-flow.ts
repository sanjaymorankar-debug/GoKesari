/**
 * Onboarding v2, Flow 2 — shop onboarding (docs/onboarding-v2-2026-11): the actions of a v2 registration draft
 * (flow_version = 'v2', given to every draft started while the onboarding_v2 flag is on). The original wizard
 * (services/shop-registration-wizard.ts) is reused for referral, GST / PAN, owner name, shop type, address and pin;
 * this file adds what v2 changes:
 *
 *   1  identity   Terms tick + e-mail (Google or a code) + mobile code; skipped for a signed-in customer whose
 *                 e-mail and mobile are both verified. Where no SMS can be sent and rule
 *                 onboardingV2.mobileOtpFallbackWhenNoSms is on, the mobile is saved unverified (DEFAULT #8).
 *   4  fee        straight after GST / PAN: Shop or Wholesale (DEFAULT #10), amount from rule onboardingV2 (+GST when
 *                 feeGstExtra), online only, a payment intent SHOP_REGISTRATION_DRAFT_FEE on the DRAFT (the shop row
 *                 does not exist yet). Not completed: the draft stays "pending payment" and resumes here.
 *   6  licences   per required licence: Enter details / Upload file / Scan / Upload later (PROMISED — not for a
 *                 MUST_HAVE licence, DEFAULT #12). Rows in registration_licence_entries.
 *   6b agreement  the shop row is created (PENDING) when the owner reaches it — the agreements are built from the
 *                 shop row — and the owner signs (seller_agreements_enabled) or accepts the Seller Terms.
 *                 DEFAULT – confirm with Sanjay: the agreement comes after address + pin (both mandatory) so it is
 *                 personalised with the real address; it is still after the licences (DEFAULT #3).
 *   8  go-live    the fee paid on the draft is on the shop's ledger already; GST / PAN verified + fee paid → live
 *                 through the existing auto-approval, else the existing operator review. Welcome kit (banners, QR)
 *                 and the signed copies in English, Marathi and Hindi as today.
 *
 * Background: the owner's customer wallet exists (created if missing) and the shop_owner grant is recorded in
 * onboarding_role_history. External side effects (gateway, e-mail, SMS) never run inside a transaction.
 */
import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { parseIndianMobile } from "@/lib/contact";
import { decryptBytes, encryptBytes } from "@/lib/pan-crypto";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { safeReturnPath } from "@/lib/onboarding-v2/return-to";
import { db, type DbClient } from "@/server/db";
import {
  registrationLicenceEntries,
  registrationLicenceFiles,
  shopRegistrationDraftChecks,
  shopRegistrationDrafts,
  shops,
  users,
  wallets,
  type LicenceEntryStatus,
  type LicenceOption,
  type Shop,
  type ShopRegistrationDraft,
  type UserRole,
} from "@/server/db/schema";
import type { PaymentIntentRef } from "@/server/payments/intents";
import { createPaymentIntent, getPaymentIntentRow, isLive, listIntentsFor, redirectUrlOf } from "@/server/payments/intents";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { recordConsent } from "@/server/services/consents";
import { getRule } from "@/server/services/settings";
import { auditActorOf, findOpenDraft, lockOpenDraft, message, type Actor } from "@/server/services/shop-registration-draft";
import { getWizardDraft, submitDraftDocument, submitDraftForPayment, toWizardView, type WizardView } from "@/server/services/shop-registration-wizard";
import { onboardingV2Enabled, recordRoleChange } from "./roles";
import { DRAFT_FEE_PURPOSE, ONBOARDING_V2_TERMS_VERSION, v2Details, v2FeeQuote, WHOLESALE_SHOP_TYPE, type V2FeeKind } from "./shop-view";

/* ------------------------------------------------------------- helpers */

async function openV2Draft(ownerId: string): Promise<ShopRegistrationDraft> {
  const draft = await findOpenDraft(ownerId);
  if (!draft) throw notFound("Registration in progress");
  if (draft.flowVersion !== "v2") throw conflict("This registration follows the earlier steps.", { reason: "NOT_V2" });
  return draft;
}

/** Merges keys into the draft's details (and other columns) under the draft lock. */
async function patchDraft(ownerId: string, patch: Record<string, unknown>, columns: Partial<typeof shopRegistrationDrafts.$inferInsert> = {}): Promise<ShopRegistrationDraft> {
  return db.transaction(async (tx) => {
    const locked = await lockOpenDraft(tx, ownerId);
    if (locked.flowVersion !== "v2") throw conflict("This registration follows the earlier steps.", { reason: "NOT_V2" });
    const [updated] = await tx
      .update(shopRegistrationDrafts)
      .set({ details: { ...((locked.details as Record<string, unknown> | null) ?? {}), ...patch }, ...columns, updatedAt: new Date() })
      .where(eq(shopRegistrationDrafts.id, locked.id))
      .returning();
    return updated;
  });
}

async function accountOf(userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) throw notFound("User");
  return u;
}

/* ---------------------------------------------------- start, return-to */

/**
 * /shop/register with the flag on: the owner's v2 draft is opened (created if none is open), so the first screen
 * is the identity step. `returnTo` (?return=…) is kept on the draft when it is a same-site path.
 */
export async function startV2Draft(actor: Actor, options: { returnTo?: string | null } = {}): Promise<WizardView | null> {
  if (!(await onboardingV2Enabled())) return null;
  const returnTo = safeReturnPath(options.returnTo ?? null);
  const draft = await db.transaction(async (tx) => {
    const locked = await lockOpenDraft(tx, actor.id);
    if (!returnTo || locked.flowVersion !== "v2") return locked;
    const [updated] = await tx
      .update(shopRegistrationDrafts)
      .set({ details: { ...((locked.details as Record<string, unknown> | null) ?? {}), v2ReturnTo: returnTo } })
      .where(eq(shopRegistrationDrafts.id, locked.id))
      .returning();
    return updated;
  });
  return toWizardView(draft);
}

/* ------------------------------------------------------------ identity */

/** Identity: the Terms tick, recorded with its version and time (consent TERMS_AND_PRIVACY). */
export async function acceptV2Terms(actor: Actor, input: { accept: boolean; ip?: string | null; userAgent?: string | null }): Promise<WizardView> {
  if (input.accept !== true) throw validationFailed("Please accept the Terms to continue.", { fields: { terms: "Tick to accept the Terms." } });
  const draft = await patchDraft(actor.id, { v2TermsAcceptedAt: new Date().toISOString(), v2TermsVersion: ONBOARDING_V2_TERMS_VERSION });
  await recordConsent(actor.id, "TERMS_AND_PRIVACY", {
    version: ONBOARDING_V2_TERMS_VERSION,
    ipAddress: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    source: "shop-onboarding-v2",
  });
  return toWizardView(draft);
}

/**
 * Identity: a code to the e-mail. An account with a real e-mail confirms that one; a mobile-only account (placeholder
 * e-mail) adds one. Google sign-in already counts as verified (shop-view.ts). DEFAULT – confirm with Sanjay: a code is
 * used instead of a magic link here, because the owner is already signed in (the sign-in page offers Google / link).
 */
export async function requestV2EmailCode(actor: Actor, input: { email?: string | null; ip?: string | null }) {
  const owner = await accountOf(actor.id);
  const otp = await import("@/server/otp/service");
  const placeholder = owner.emailPlaceholder || isPlaceholderEmail(owner.email);
  if (placeholder || (input.email && input.email.trim().toLowerCase() !== owner.email.toLowerCase())) {
    if (!input.email) throw validationFailed("Enter your e-mail address.", { fields: { email: "Enter your e-mail address." } });
    return otp.requestEmailChangeOtp(actor.id, { email: input.email, ip: input.ip ?? null });
  }
  return otp.issueCode({ email: owner.email, purpose: "EMAIL_CHANGE", userId: actor.id, phoneE164: null, ip: input.ip ?? null });
}

export async function confirmV2EmailCode(actor: Actor, input: { email?: string | null; code: string; ip?: string | null }): Promise<WizardView> {
  const owner = await accountOf(actor.id);
  const otp = await import("@/server/otp/service");
  const placeholder = owner.emailPlaceholder || isPlaceholderEmail(owner.email);
  if (placeholder || (input.email && input.email.trim().toLowerCase() !== owner.email.toLowerCase())) {
    if (!input.email) throw validationFailed("Enter your e-mail address.", { fields: { email: "Enter your e-mail address." } });
    await otp.confirmEmailChange(actor.id, actor.role, { email: input.email, code: input.code, ip: input.ip ?? null });
    await db.update(users).set({ emailPlaceholder: false, updatedAt: new Date() }).where(eq(users.id, actor.id));
  } else {
    await otp.consumeCode({ email: owner.email, purpose: "EMAIL_CHANGE", code: input.code, ip: input.ip ?? null, userId: actor.id });
    await db.update(users).set({ emailVerified: new Date(), updatedAt: new Date() }).where(eq(users.id, actor.id));
  }
  return toWizardView(await openV2Draft(actor.id));
}

/**
 * Identity: the mobile code by SMS. With no SMS provider and rule onboardingV2.mobileOtpFallbackWhenNoSms on, the
 * mobile is saved unverified and the step counts as done (DEFAULT #8, the same rule as the customer flow).
 */
export async function requestV2MobileCode(actor: Actor, input: { mobile: string; ip?: string | null }): Promise<{ sent: boolean; view: WizardView }> {
  const parsed = parseIndianMobile(input.mobile);
  if (!parsed.ok) throw validationFailed(parsed.error, { fields: { mobile: parsed.error } });
  const otp = await import("@/server/otp/service");
  await otp.assertPhoneFree(parsed.e164, actor.id);
  const owner = await accountOf(actor.id);
  if (await otp.guestMobileCodesAvailable()) {
    await otp.requestGuestMobileOtp({ email: owner.email, mobile: parsed.national, ip: input.ip ?? null });
    return { sent: true, view: await toWizardView(await openV2Draft(actor.id)) };
  }
  const { mobileOtpFallbackWhenNoSms } = await getRule("onboardingV2");
  if (!mobileOtpFallbackWhenNoSms) {
    throw conflict("We can't send an SMS code right now. Please try again later.", { reason: "SMS_UNAVAILABLE" });
  }
  await otp.linkPhone(actor.id, actor.role, { mobile: parsed.national });
  const draft = await patchDraft(actor.id, { v2MobileUnverified: true });
  return { sent: false, view: await toWizardView(draft) };
}

export async function confirmV2MobileCode(actor: Actor, input: { mobile: string; code: string; ip?: string | null }): Promise<WizardView> {
  const owner = await accountOf(actor.id);
  const otp = await import("@/server/otp/service");
  const e164 = await otp.verifyGuestMobileOtp({ email: owner.email, mobile: input.mobile, code: input.code, ip: input.ip ?? null });
  await otp.assertPhoneFree(e164, actor.id);
  const parsed = parseIndianMobile(e164);
  await db
    .update(users)
    .set({ phoneE164: e164, phone: parsed.ok ? parsed.national : null, phoneVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, actor.id));
  const draft = await patchDraft(actor.id, { v2MobileUnverified: false });
  return toWizardView(draft);
}

/* ------------------------------------------------------------------ fee */

/**
 * Step 4: the fee, straight after GST / PAN. The owner confirms the shop (and owner) name pre-filled from the record,
 * picks Shop or Wholesale and pays online. Returns where to send the browser (gateway or our sandbox page).
 * A checkout still open for the same amount is reused; a paid draft refuses a new one.
 */
export async function startDraftFeeCheckout(
  actor: Actor,
  input: { kind: V2FeeKind; shopName: string; ownerName?: string | null },
): Promise<{ intentId: string | null; amountPaise: number; redirectUrl: string | null; view: WizardView }> {
  const draft = await openV2Draft(actor.id);
  if (draft.feePaidAt) throw conflict("The registration fee is already paid.", { reason: "FEE_PAID" });
  const view = await toWizardView(draft);
  if (view.nextStep !== "FEE") throw conflict("Please finish the earlier steps first.", { reason: "STEP_OPEN", nextStep: view.nextStep });
  const shopName = input.shopName.trim();
  if (shopName.length < 2 || shopName.length > 120) throw validationFailed("Please check the highlighted fields.", { fields: { shopName: "Enter your shop's name." } });
  const ownerName = input.ownerName?.trim() || null;
  if (ownerName !== null && ownerName.length < 2) throw validationFailed("Please check the highlighted fields.", { fields: { ownerName: "Enter the owner's name." } });

  const quote = await v2FeeQuote(input.kind);
  const old = v2Details(draft) as Record<string, unknown>;
  const typePatch =
    input.kind === "WHOLESALE"
      ? { shopType: WHOLESALE_SHOP_TYPE }
      : old.shopType === WHOLESALE_SHOP_TYPE
        ? { shopType: undefined }
        : {};
  const paidNow = quote.totalPaise === 0;
  const saved = await patchDraft(
    actor.id,
    { v2ShopName: shopName, ...(ownerName ? { ownerName } : {}), v2Fee: quote, ...typePatch },
    { feeKind: input.kind, feePaise: quote.basePaise, ...(paidNow ? { feePaidAt: new Date() } : {}) },
  );
  if (paidNow) return { intentId: null, amountPaise: 0, redirectUrl: null, view: await toWizardView(saved) };

  const owner = await accountOf(actor.id);
  const previous = (await listIntentsFor(DRAFT_FEE_PURPOSE, draft.id)).filter((r) => r.userId === actor.id);
  const open = previous.find((row) => isLive(row) && row.amountPaise === quote.totalPaise && row.mode === "CHECKOUT");
  const openUrl = open ? redirectUrlOf(open) : null;
  let intentId: string;
  let redirectUrl: string | null;
  if (open && openUrl) {
    intentId = open.id;
    redirectUrl = openUrl;
  } else {
    const created = await createPaymentIntent({
      purpose: DRAFT_FEE_PURPOSE,
      referenceId: draft.id,
      userId: actor.id,
      amountPaise: quote.totalPaise,
      customer: {
        id: actor.id,
        name: ownerName ?? owner.name ?? view.ownerName,
        email: isPlaceholderEmail(owner.email) ? null : owner.email,
        phone: owner.phoneE164?.startsWith("+91") ? owner.phoneE164.slice(3) : null,
      },
      description: `GoKesari ${input.kind === "WHOLESALE" ? "wholesale shop" : "shop"} registration fee — ${shopName}`,
      // Same attempt → same intent; after a failed or expired attempt the count has moved on, so a retry is new.
      idempotencyKey: `shop-draft-fee:${draft.id}:${previous.length}`,
      mode: "CHECKOUT",
      returnPath: "/shop/register",
    });
    const checkout = created.checkout;
    redirectUrl = checkout ? (checkout.kind === "HOSTED_URL" ? checkout.url : (checkout.url ?? null)) : null;
    intentId = created.intent.id;
    if (!redirectUrl) throw conflict("Online payment is not available right now. Please try again in a few minutes.");
  }
  await db.update(shopRegistrationDrafts).set({ feePaymentIntentId: intentId }).where(eq(shopRegistrationDrafts.id, draft.id));
  return { intentId, amountPaise: quote.totalPaise, redirectUrl, view: await toWizardView((await findOpenDraft(actor.id))!) };
}

/**
 * Capture handler (payments/purpose-handlers.ts), inside the capture transaction: the draft's fee is paid.
 * Idempotent. DEFAULT – confirm with Sanjay: a second capture for an already-paid draft (two checkouts paid, e.g. the
 * kind changed while one was open) is not applied; it is logged (audit + error log) for support to refund.
 */
export async function onDraftFeeCaptured(intent: PaymentIntentRef, client: DbClient): Promise<void> {
  const now = new Date();
  const [current] = await client
    .select({ id: shopRegistrationDrafts.id, feePaidAt: shopRegistrationDrafts.feePaidAt, feePaymentIntentId: shopRegistrationDrafts.feePaymentIntentId })
    .from(shopRegistrationDrafts)
    .where(eq(shopRegistrationDrafts.id, intent.referenceId))
    .for("update");
  const duplicate = Boolean(current?.feePaidAt && current.feePaymentIntentId !== intent.id);
  if (current && !current.feePaidAt) {
    await client
      .update(shopRegistrationDrafts)
      .set({ feePaidAt: now, feePaymentIntentId: intent.id, updatedAt: now })
      .where(eq(shopRegistrationDrafts.id, current.id));
  }
  if (!current || duplicate) {
    console.error("[onboarding-v2] draft fee capture needs support", intent.id, current ? "already paid by another payment — refund" : "draft not found");
  }
  await recordAudit(
    {
      actorId: intent.userId,
      actorRole: null,
      action: AUDIT_ACTIONS.SHOP_REGISTRATION_DRAFT_FEE_PAID,
      entityType: "shop_registration_draft",
      entityId: intent.referenceId,
      newValue: { intentId: intent.id, amountPaise: intent.amountPaise, gateway: intent.gateway, problem: !current ? "draft_not_found" : duplicate ? "already_paid_refund_needed" : null },
    },
    client,
  );
}

/** Back from the gateway (or opening the fee step): ask the gateway about the latest open attempt. */
export async function refreshDraftFeeAttempt(ownerId: string): Promise<boolean> {
  const draft = await findOpenDraft(ownerId);
  if (!draft || draft.flowVersion !== "v2" || draft.feePaidAt) return false;
  const [latest] = (await listIntentsFor(DRAFT_FEE_PURPOSE, draft.id)).filter((r) => r.userId === ownerId);
  if (!latest || !isLive(latest)) return false;
  try {
    await (await import("@/server/payments/processing")).reconcileIntent(latest.id);
  } catch (error) {
    console.error("[onboarding-v2] could not check the draft fee with the gateway", latest.id, error);
  }
  return true;
}

/* ------------------------------------------------------------- licences */

export const LICENCE_CHECKABLE = new Set(["FSSAI", "UDYAM", "SHOP_ACT"]);
const MAX_FILE_BYTES = 10_000_000;

export interface LicenceEntryInput {
  licenceKey: string;
  option: LicenceOption;
  number?: string | null;
  holderName?: string | null;
  validUntil?: string | null;
  issuingAuthority?: string | null;
  /** The owner agreed to the government check (FSSAI / Udyam / Shop Act numbers). */
  consent?: boolean;
  /** Upload later: "I don't have this document right now, I will upload it within <period>". */
  promise?: boolean;
  /** What the device's reader read (Scan / Upload), kept for the operator. */
  ocr?: Record<string, string | null> | null;
  file?: { data: Buffer; source: "FILE" | "CAMERA" } | null;
  ip?: string | null;
}

const clean = (v: string | null | undefined, max: number) => {
  const t = v?.trim();
  return t ? t.slice(0, max) : null;
};

/**
 * Stores an uploaded / scanned licence file (encrypted). Returns its id.
 * DEFAULT – confirm with Sanjay: a registration file stays in registration_licence_files (operators open it from the
 * registration-licences queue); it is not copied into the shop's legal-documents register, where the owner can still
 * upload it after go-live (My shop → Documents).
 */
async function storeLicenceFile(draft: ShopRegistrationDraft, licenceKey: string, file: NonNullable<LicenceEntryInput["file"]>): Promise<string> {
  if (file.data.length === 0) throw validationFailed("The file is empty.", { fields: { file: "Attach the document." } });
  const max = (await getRule("uploads")).sellerDocumentMaxBytes ?? MAX_FILE_BYTES;
  if (file.data.length > max) throw validationFailed(`The file can be at most ${max / 1_000_000} MB.`, { fields: { file: "File too large." } });
  const { detectDocumentFile } = await import("@/server/services/seller-verification");
  const contentType = detectDocumentFile(file.data);
  if (!contentType) throw validationFailed("Upload the document as a PDF, JPG or PNG file.", { fields: { file: "PDF, JPG or PNG only." } });
  const [row] = await db
    .insert(registrationLicenceFiles)
    .values({
      draftId: draft.id,
      ownerUserId: draft.ownerId,
      licenceKey,
      source: file.source,
      contentType,
      sizeBytes: file.data.length,
      sha256: createHash("sha256").update(file.data).digest("hex"),
      dataEncrypted: encryptBytes(file.data),
    })
    .returning({ id: registrationLicenceFiles.id });
  return row.id;
}

/** The draft check's outcome for a checkable licence, after submitDraftDocument. */
async function draftCheckOutcome(draftId: string, docType: string): Promise<{ status: LicenceEntryStatus | "REFUSED"; reason: string | null; ref: string | null }> {
  const [row] = await db
    .select()
    .from(shopRegistrationDraftChecks)
    .where(and(eq(shopRegistrationDraftChecks.draftId, draftId), eq(shopRegistrationDraftChecks.docType, docType as never)));
  if (!row) return { status: "PENDING_OPERATOR", reason: "Waiting for GoKesari's team.", ref: null };
  if (row.status === "VERIFIED") return { status: "VERIFIED", reason: null, ref: row.providerRef };
  if (row.status === "FAILED" || row.status === "EXPIRED") return { status: "REFUSED", reason: message(row.status, row.errorCode), ref: row.providerRef };
  return { status: "PENDING_OPERATOR", reason: message(row.status, row.errorCode), ref: row.providerRef };
}

/**
 * Step 6: one licence answered with one of the four options. Enter / Scan: the number (verified online where an
 * adapter exists — FSSAI, Udyam, Shop Act — else checked by an operator). Upload: the file, read on the device where
 * possible (DEFAULT – confirm with Sanjay: the server's own OCR is not started, as for every upload since D-18),
 * then an operator. Later: the promise (not for a MUST_HAVE licence), which the existing document follow-up chases
 * once the shop is live (documents_promised_at).
 */
export async function saveLicenceEntry(actor: Actor, input: LicenceEntryInput): Promise<WizardView> {
  const draft = await openV2Draft(actor.id);
  const view = await toWizardView(draft);
  if (!view.v2?.fee.paid || !view.shopType) throw conflict("Please pay the fee and choose your shop type first.", { reason: "STEP_OPEN", nextStep: view.nextStep });
  const licence = view.v2.licences.find((l) => l.key === input.licenceKey);
  if (!licence) throw notFound("Licence");
  const now = new Date();
  let status: LicenceEntryStatus;
  let statusReason: string | null = null;
  let verifyRef: string | null = null;
  let fileRef: string | null = null;
  let number = clean(input.number, 60);
  const ocr = input.ocr ?? null;

  if (input.option === "LATER") {
    // DEFAULT #12: a must-have licence is entered, uploaded or scanned — never promised.
    if (licence.level === "MUST_HAVE") {
      throw conflict(`${licence.label} is required by law before your shop can go live. Please enter, upload or scan it.`, {
        reason: "LICENCE_MUST_HAVE",
        fields: { option: "Upload later is not available for this licence." },
      });
    }
    if (input.promise !== true) {
      throw validationFailed("Tick the box to promise this document.", { fields: { promise: "Required to upload it later." } });
    }
    status = "PROMISED";
    number = null;
  } else {
    if (input.file) fileRef = await storeLicenceFile(draft, licence.key, input.file);
    if (input.option === "UPLOAD" && !fileRef) throw validationFailed("Attach the document.", { fields: { file: "Attach the document." } });
    if ((input.option === "ENTER" || input.option === "SCAN") && (!number || number.length < 3)) {
      throw validationFailed("Please check the highlighted fields.", { fields: { number: "Enter the licence number." } });
    }
    if (number && licence.checkable && LICENCE_CHECKABLE.has(licence.key)) {
      if (input.consent !== true && input.option !== "UPLOAD") {
        throw validationFailed("Please agree to the verification consent before we check this number.", { fields: { consent: "Tick to agree." } });
      }
      if (input.consent === true) {
        await submitDraftDocument({ actor, docType: licence.key as "FSSAI" | "UDYAM" | "SHOP_ACT", number, consentGiven: true, ipAddress: input.ip ?? null }).catch((error: unknown) => {
          // A number the format check refuses: on Upload the file still goes to the team; else the owner fixes it.
          if (input.option !== "UPLOAD") throw error;
        });
        const outcome = await draftCheckOutcome(draft.id, licence.key);
        if (outcome.status === "REFUSED") {
          if (input.option !== "UPLOAD") throw validationFailed(outcome.reason ?? "This number could not be verified.", { fields: { number: outcome.reason ?? "Not verified." } });
          status = "PENDING_OPERATOR";
          statusReason = outcome.reason;
        } else {
          status = outcome.status;
          statusReason = outcome.reason;
          verifyRef = outcome.ref;
        }
      } else {
        status = "PENDING_OPERATOR";
        statusReason = "GoKesari's team will check this document.";
      }
    } else {
      status = "PENDING_OPERATOR";
      statusReason = "GoKesari's team will check this document.";
    }
  }

  const values = {
    draftId: draft.id,
    ownerUserId: draft.ownerId,
    licenceKey: licence.key,
    option: input.option,
    licenceNumber: number,
    holderName: input.option === "LATER" ? null : clean(input.holderName, 120),
    validUntil: input.option === "LATER" ? null : clean(input.validUntil, 10),
    issuingAuthority: input.option === "LATER" ? null : clean(input.issuingAuthority, 120),
    fileRef,
    ocr,
    status,
    statusReason,
    promiseAcceptedAt: input.option === "LATER" ? now : null,
    verifiedAt: status === "VERIFIED" ? now : null,
    verifyRef,
    reviewedBy: null,
    reviewedAt: null,
    updatedAt: now,
  };
  await db.transaction(async (tx) => {
    await tx
      .insert(registrationLicenceEntries)
      .values(values)
      .onConflictDoUpdate({ target: [registrationLicenceEntries.draftId, registrationLicenceEntries.licenceKey], set: values });
    // Upload later feeds the existing follow-up unchanged (DEFAULT #11): the shop is promised at creation.
    const anyPromised = await tx
      .select({ id: registrationLicenceEntries.id })
      .from(registrationLicenceEntries)
      .where(and(eq(registrationLicenceEntries.draftId, draft.id), eq(registrationLicenceEntries.status, "PROMISED")))
      .limit(1);
    await tx
      .update(shopRegistrationDrafts)
      .set({ documentsPromisedAt: anyPromised.length > 0 ? (draft.documentsPromisedAt ?? now) : null, updatedAt: now })
      .where(eq(shopRegistrationDrafts.id, draft.id));
  });
  await recordAudit({
    ...auditActorOf(actor),
    action: AUDIT_ACTIONS.SHOP_REGISTRATION_LICENCE_SAVED,
    entityType: "shop_registration_draft",
    entityId: draft.id,
    ipAddress: input.ip ?? null,
    newValue: { licenceKey: licence.key, option: input.option, status, number: number ? `…${number.slice(-4)}` : null, file: fileRef !== null },
  });
  return toWizardView((await findOpenDraft(actor.id))!);
}

/* ------------------------------------------------------ agreement, live */

/**
 * Step 6b, first half: the shop row is created from the draft (PENDING_APPROVAL, the paid fee as its snapshot and on
 * its ledger) so the personalised agreement can be built from it. Idempotent: a draft already turned into its shop is
 * returned as it is.
 */
export async function prepareV2Agreement(actor: Actor, input: { ip?: string | null; userAgent?: string | null } = {}): Promise<WizardView> {
  const open = await findOpenDraft(actor.id);
  if (!open) {
    const current = await getWizardDraft(actor);
    if (current?.v2 && current.shop) return current;
    throw notFound("Registration in progress");
  }
  if (open.flowVersion !== "v2") throw conflict("This registration follows the earlier steps.", { reason: "NOT_V2" });
  return submitDraftForPayment({ actor, ipAddress: input.ip ?? null, userAgent: input.userAgent ?? null });
}

/** After registerShop (called by the wizard): ledger entry for the paid fee, the owner's wallet, the role history. */
export async function afterV2ShopCreated(shop: Shop, draft: ShopRegistrationDraft, actor: Actor): Promise<void> {
  // The customer side always exists for a shop owner (never a separate sign-up): one wallet per account.
  await db.insert(wallets).values({ userId: shop.ownerId }).onConflictDoNothing();
  await recordRoleChange({
    userId: shop.ownerId,
    role: "shop_owner",
    action: "GRANTED",
    toValue: shop.id,
    actorUserId: actor.staff?.id ?? actor.id,
    reason: `Shop registration ${shop.registrationNumber ?? shop.id} (onboarding v2)`,
  }).catch((error: unknown) => console.error("[onboarding-v2] role history not written", shop.id, error));
  // The fee paid on the draft: on the shop's immutable ledger (ONLINE, the gateway's payment id) — the same capture
  // step a shop fee uses, so the fee status, subscription and auto-approval evidence follow. Go-live itself waits
  // for the agreement (autoApproveShopIfReady refuses while it is pending).
  if (draft.feePaymentIntentId && (shop.registrationFeePaise ?? 0) > 0) {
    const intent = await getPaymentIntentRow(draft.feePaymentIntentId);
    if (intent && intent.status === "CAPTURED") {
      const { onShopRegistrationFeeCaptured } = await import("@/server/services/operator-limited");
      await onShopRegistrationFeeCaptured(
        {
          id: intent.id,
          purpose: "SHOP_REGISTRATION_FEE",
          referenceId: shop.id,
          userId: intent.userId,
          amountPaise: intent.amountPaise,
          refundedPaise: intent.refundedPaise,
          status: intent.status,
          gateway: intent.gateway,
          gatewayOrderId: intent.gatewayOrderId,
          gatewayPaymentId: intent.gatewayPaymentId,
        },
        db,
      ).catch((error: unknown) => console.error("[onboarding-v2] draft fee not recorded on the shop", shop.id, error));
    }
  }
}

/**
 * Step 6b, second half, and go-live: the owner accepts the seller agreement. With seller_agreements_enabled the
 * personalised agreements must be OTP-signed first (AgreementsSigner, the existing flow); otherwise the owner ticks
 * the Seller Terms. The goods undertaking is ticked either way. Then the existing auto-approval decides: GST / PAN
 * verified + fee paid → live (welcome kit with banners + signed copies); else the operator review.
 */
export async function acceptV2Agreement(
  actor: Actor,
  input: { acceptSellerTerms?: boolean; acceptUndertaking?: boolean; ip?: string | null; userAgent?: string | null },
): Promise<WizardView> {
  const [draft] = await db
    .select()
    .from(shopRegistrationDrafts)
    .where(and(eq(shopRegistrationDrafts.ownerId, actor.id), eq(shopRegistrationDrafts.flowVersion, "v2"), inArray(shopRegistrationDrafts.status, ["SUBMITTED", "COMPLETED"])))
    .orderBy(desc(shopRegistrationDrafts.updatedAt))
    .limit(1);
  if (!draft?.shopId) throw notFound("Registration in progress");
  if (draft.slaAcceptedAt) return toWizardView(draft);
  const { getAgreementStatus } = await import("@/server/legal-agreements/requirements");
  const status = await getAgreementStatus(draft.shopId).catch(() => null);
  const signedInAgreements = Boolean(status?.enabled && !status.noPublishedDocuments);
  if (status?.enabled && status.required) {
    throw conflict("Please read and sign your seller agreement first.", { reason: "AGREEMENT_NOT_SIGNED" });
  }
  if ((!signedInAgreements && input.acceptSellerTerms !== true) || input.acceptUndertaking !== true) {
    throw validationFailed("Tick the boxes to accept the seller agreement and the seller undertaking.", {
      reason: "SELLER_ACCEPTANCE_REQUIRED",
      fields: { ...(input.acceptUndertaking !== true ? { acceptUndertaking: "Required." } : {}), ...(!signedInAgreements && input.acceptSellerTerms !== true ? { acceptSellerTerms: "Required." } : {}) },
    });
  }
  const { acceptSellerUndertaking } = await import("@/server/services/seller-undertaking");
  const now = new Date();
  await db.transaction(async (tx) => {
    await acceptSellerUndertaking({ userId: actor.id, shopIds: [draft.shopId!], ip: input.ip ?? null, userAgent: input.userAgent ?? null, actorRole: actor.role, client: tx, includeTerms: !signedInAgreements });
    await tx.update(shopRegistrationDrafts).set({ slaAcceptedAt: now, updatedAt: now }).where(eq(shopRegistrationDrafts.id, draft.id));
  });
  await recordAudit({
    ...auditActorOf(actor),
    action: AUDIT_ACTIONS.SHOP_REGISTRATION_SLA_ACCEPTED,
    entityType: "shop",
    entityId: draft.shopId,
    ipAddress: input.ip ?? null,
    newValue: { draftId: draft.id, signedAgreements: signedInAgreements },
  });
  await goLiveV2(draft.shopId);
  const [final] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, draft.id));
  return toWizardView(final);
}

/** Step 8: the existing auto-approval (GST / PAN verified + fee paid through the gateway), else operator review. */
export async function goLiveV2(shopId: string): Promise<boolean> {
  const { autoApproveShopIfReady } = await import("@/server/services/shops");
  const approved = await autoApproveShopIfReady(shopId).catch((error: unknown) => {
    console.error("[onboarding-v2] auto-approval check failed", shopId, error);
    return false;
  });
  // The signed copies (EN / MR / HI) ride on the welcome kit of a live shop; this queues them once if needed.
  await import("@/server/legal-agreements/email")
    .then((m) => m.onRegistrationFeePaid(shopId))
    .catch((error: unknown) => console.error("[onboarding-v2] signed-copy e-mail failed", shopId, error));
  return approved;
}

/* -------------------------------------------------------- admin queue */

export interface LicenceQueueRow {
  id: string;
  draftId: string;
  shopId: string | null;
  shopName: string | null;
  ownerUserId: string;
  licenceKey: string;
  option: LicenceOption;
  status: LicenceEntryStatus;
  statusReason: string | null;
  licenceNumber: string | null;
  holderName: string | null;
  validUntil: string | null;
  issuingAuthority: string | null;
  hasFile: boolean;
  promiseAcceptedAt: string | null;
  /** PROMISED: the shop's promise deadline (shops.documents_due_at), shown in IST. */
  promiseDueAt: string | null;
  updatedAt: string;
}

/** Admin → Shop documents → Registration licences: the operator queue (PENDING_OPERATOR) and the promises. */
export async function listRegistrationLicences(filter: { status?: LicenceEntryStatus | "ALL"; shopId?: string | null; limit?: number } = {}): Promise<LicenceQueueRow[]> {
  const conditions = [];
  if (filter.status && filter.status !== "ALL") conditions.push(eq(registrationLicenceEntries.status, filter.status));
  if (filter.shopId) conditions.push(eq(registrationLicenceEntries.shopId, filter.shopId));
  const rows = await db
    .select({
      e: registrationLicenceEntries,
      shopName: shops.name,
      dueAt: shops.documentsDueAt,
    })
    .from(registrationLicenceEntries)
    .leftJoin(shops, eq(shops.id, registrationLicenceEntries.shopId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(registrationLicenceEntries.updatedAt))
    .limit(Math.min(filter.limit ?? 200, 500));
  return rows.map(({ e, shopName, dueAt }) => ({
    id: e.id,
    draftId: e.draftId,
    shopId: e.shopId,
    shopName: shopName ?? null,
    ownerUserId: e.ownerUserId,
    licenceKey: e.licenceKey,
    option: e.option,
    status: e.status,
    statusReason: e.statusReason,
    licenceNumber: e.licenceNumber,
    holderName: e.holderName,
    validUntil: e.validUntil,
    issuingAuthority: e.issuingAuthority,
    hasFile: e.fileRef !== null,
    promiseAcceptedAt: e.promiseAcceptedAt?.toISOString() ?? null,
    promiseDueAt: e.status === "PROMISED" && dueAt ? dueAt.toISOString() : null,
    updatedAt: e.updatedAt.toISOString(),
  }));
}

/**
 * An operator approves (VERIFIED) or rejects (REJECTED, the owner is asked again) a licence waiting for the team.
 * DEFAULT – confirm with Sanjay: the decision is on the registration record only; a shop held for it is then approved
 * in Admin → Shops as today (the existing operator review), not automatically.
 */
export async function reviewRegistrationLicence(
  entryId: string,
  decision: { approve: boolean; reason?: string | null },
  reviewer: { id: string; role: UserRole },
): Promise<LicenceQueueRow> {
  const [entry] = await db.select().from(registrationLicenceEntries).where(eq(registrationLicenceEntries.id, entryId));
  if (!entry) throw notFound("Licence");
  if (entry.status !== "PENDING_OPERATOR") throw conflict("Only a licence waiting for the team can be decided.", { reason: "NOT_PENDING" });
  const reason = decision.reason?.trim() || null;
  if (!decision.approve && !reason) throw validationFailed("Give the reason for the rejection.", { fields: { reason: "Required." } });
  const now = new Date();
  await db
    .update(registrationLicenceEntries)
    .set({
      status: decision.approve ? "VERIFIED" : "REJECTED",
      statusReason: decision.approve ? "Checked by GoKesari's team." : reason,
      verifiedAt: decision.approve ? now : null,
      reviewedBy: reviewer.id,
      reviewedAt: now,
      updatedAt: now,
    })
    .where(eq(registrationLicenceEntries.id, entryId));
  await recordAudit({
    actorId: reviewer.id,
    actorRole: reviewer.role,
    action: AUDIT_ACTIONS.SHOP_REGISTRATION_LICENCE_REVIEWED,
    entityType: "registration_licence_entry",
    entityId: entryId,
    newValue: { approve: decision.approve, reason, licenceKey: entry.licenceKey, shopId: entry.shopId },
  });
  const [row] = (await listRegistrationLicences({ status: "ALL", limit: 500 })).filter((r) => r.id === entryId);
  return row;
}

/** The file of a licence entry, for an operator (every open is audited). */
export async function readRegistrationLicenceFile(entryId: string, viewer: { id: string; role: UserRole }): Promise<{ data: Buffer; contentType: string }> {
  const [entry] = await db.select().from(registrationLicenceEntries).where(eq(registrationLicenceEntries.id, entryId));
  if (!entry?.fileRef) throw notFound("File");
  const [file] = await db.select().from(registrationLicenceFiles).where(eq(registrationLicenceFiles.id, entry.fileRef));
  if (!file) throw notFound("File");
  await recordAudit({
    actorId: viewer.id,
    actorRole: viewer.role,
    action: AUDIT_ACTIONS.SHOP_REGISTRATION_LICENCE_REVIEWED,
    entityType: "registration_licence_file",
    entityId: file.id,
    newValue: { opened: true, entryId },
  });
  return { data: decryptBytes(file.dataEncrypted), contentType: file.contentType };
}
