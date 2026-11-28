/**
 * Onboarding v2, Flow 2 — shop onboarding (docs/onboarding-v2-2026-11): the actions of a v2 registration draft
 * (flow_version = 'v2', given to every draft started while the onboarding_v2 flag is on). The original wizard
 * (services/shop-registration-wizard.ts) is reused for referral, GST / PAN, owner name, shop type, address and pin;
 * this file adds what v2 changes:
 *
 *   1  identity   Terms tick + e-mail (Google or a code) + mobile code; skipped for a signed-in customer whose
 *                 e-mail and mobile are both verified. Where no SMS can be sent and rule
 *                 onboardingV2.mobileOtpFallbackWhenNoSms is on, the mobile is saved unverified (DEFAULT #8).
 *   4  fee        straight after GST / PAN (owner, 27-Nov-2026): the original fee — the annual turnover band of rule
 *                 registrationFeeByTurnover (₹999 / ₹4,999 / ₹9,999 + GST by default; the flat fee when that rule is
 *                 off), less an optional registration-fee coupon — online only, a payment intent
 *                 SHOP_REGISTRATION_DRAFT_FEE on the DRAFT (the shop row does not exist yet). Not completed: the draft
 *                 stays "pending payment" and resumes here. Wholesale stores pay the same and pick their type after.
 *   6  licences   per required licence: Enter details / Upload file / Scan / Upload later (PROMISED — any licence,
 *                 must-have ones included, owner 27-Nov-2026). Rows in registration_licence_entries. None holds go-live.
 *   6b agreement  the shop row is created (PENDING) when the owner reaches it — the agreements are built from the
 *                 shop row — and the owner accepts them with the ticks and their name, no OTP (owner, 27-Nov-2026;
 *                 seller_agreements_enabled), or accepts the Seller Terms.
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

import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

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
  shopFeePayLater,
  shopRegistrationDrafts,
  shops,
  users,
  wallets,
  type LicenceEntryStatus,
  type PaymentIntentRow,
  type LicenceOption,
  type Shop,
  type ShopRegistrationDraft,
  type UserRole,
} from "@/server/db/schema";
import type { PaymentIntentRef } from "@/server/payments/intents";
import { createPaymentIntent, getPaymentIntentRow, isLive, isPaid, listIntentsFor, redirectUrlOf } from "@/server/payments/intents";
import { flagPaymentForSupport, lockIntent, transitionIntent } from "@/server/payments/intent-store";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { recordConsent } from "@/server/services/consents";
import { getRule } from "@/server/services/settings";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getOrCreateShopWallet } from "@/server/services/shop-wallet";
import { auditActorOf, findOpenDraft, lockOpenDraft, message, type Actor } from "@/server/services/shop-registration-draft";
import { getWizardDraft, submitDraftDocument, submitDraftForPayment, toWizardView, type WizardView } from "@/server/services/shop-registration-wizard";
import { onboardingV2Enabled, recordRoleChange } from "./roles";
import { DRAFT_FEE_PURPOSE, ONBOARDING_V2_TERMS_VERSION, v2FeeQuote, WHOLESALE_SHOP_TYPE, type V2FeeQuote } from "./shop-view";

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
  // docs/dual-auth-2026-11: the shared DualVerify e-mail step (code to the account's address, or the address a
  // mobile-only owner adds; account check after the code).
  const dual = await import("@/server/dual-auth/policy");
  if (await dual.dualAuthInForce()) {
    const { sendEmailFactorCode } = await import("@/server/dual-auth/verify");
    const sent = await sendEmailFactorCode(actor.id, input.email ?? null, input.ip ?? null);
    return { maskedEmail: sent.sentTo, resendAfterSeconds: sent.resendAfterSeconds, expiryMinutes: sent.expiryMinutes };
  }
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
  const dual = await import("@/server/dual-auth/policy");
  if (await dual.dualAuthInForce()) {
    const { confirmEmailFactorCode } = await import("@/server/dual-auth/verify");
    await confirmEmailFactorCode(actor.id, input.email ?? null, input.code, input.ip ?? null, "shop_identity");
    return toWizardView(await openV2Draft(actor.id));
  }
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
  // docs/dual-auth-2026-11: the shared DualVerify mobile step (strict SMS code; account check after the code).
  const dual = await import("@/server/dual-auth/policy");
  if (await dual.dualAuthFlagOn()) {
    if (!(await dual.dualAuthInForce())) throw conflict("We can't send an SMS code right now. Please try again later.", { reason: "SMS_UNAVAILABLE" });
    const { sendMobileFactorCode } = await import("@/server/dual-auth/verify");
    await sendMobileFactorCode(actor.id, parsed.e164, input.ip ?? null);
    return { sent: true, view: await toWizardView(await openV2Draft(actor.id)) };
  }
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
  const dual = await import("@/server/dual-auth/policy");
  if (await dual.dualAuthInForce()) {
    const { confirmMobileFactorCode } = await import("@/server/dual-auth/verify");
    await confirmMobileFactorCode(actor.id, input.mobile, input.code, input.ip ?? null, "shop_identity");
    return toWizardView(await patchDraft(actor.id, { v2MobileUnverified: false }));
  }
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
 * picks the annual turnover band (owner, 27-Nov-2026: the original slabs and fees; wholesale shops pay the same and
 * choose Wholesale store at the shop-type step), an optional registration-fee coupon, and pays online. Returns where
 * to send the browser (gateway or our sandbox page). A checkout still open for the same quote is reused; a paid draft
 * refuses a new one.
 */
export async function startDraftFeeCheckout(
  actor: Actor,
  input: { slab: number | null; couponCode?: string | null; shopName: string; ownerName?: string | null },
): Promise<{ intentId: string | null; amountPaise: number; redirectUrl: string | null; view: WizardView }> {
  const draft = await openV2Draft(actor.id);
  if (draft.feePaidAt) throw conflict("The registration fee is already paid.", { reason: "FEE_PAID" });
  // The fee kind is locked once any payment for this draft was captured (even if the draft is not marked yet).
  const allIntents = await listIntentsFor(DRAFT_FEE_PURPOSE, draft.id);
  if (allIntents.some((row) => isPaid(row))) throw conflict("The registration fee is already paid.", { reason: "FEE_PAID" });
  const view = await toWizardView(draft);
  // 0229: after "Pay later" the owner may still pay now (the request then ends when the payment is captured).
  if (view.nextStep !== "FEE" && !draft.feeDeferredAt) throw conflict("Please finish the earlier steps first.", { reason: "STEP_OPEN", nextStep: view.nextStep });
  const shopName = input.shopName.trim();
  if (shopName.length < 2 || shopName.length > 120) throw validationFailed("Please check the highlighted fields.", { fields: { shopName: "Enter your shop's name." } });
  const ownerName = input.ownerName?.trim() || null;
  if (ownerName !== null && ownerName.length < 2) throw validationFailed("Please check the highlighted fields.", { fields: { ownerName: "Enter the owner's name." } });

  const quote = await v2FeeQuote({ ownerId: actor.id, slab: input.slab, couponCode: input.couponCode ?? null });
  // An unpaid choice of the old "wholesale" fee (before 27-Nov-2026) had set the shop type: the type step asks again.
  const typePatch = draft.feeKind === "WHOLESALE" ? { shopType: undefined } : {};
  const paidNow = quote.totalPaise === 0;
  const saved = await patchDraft(
    actor.id,
    { v2ShopName: shopName, ...(ownerName ? { ownerName } : {}), v2Fee: quote, ...typePatch },
    { feeKind: null, feePaise: quote.basePaise, ...(paidNow ? { feePaidAt: new Date() } : {}) },
  );
  if (paidNow) return { intentId: null, amountPaise: 0, redirectUrl: null, view: await toWizardView(saved) };

  const owner = await accountOf(actor.id);
  const previous = allIntents.filter((r) => r.userId === actor.id);
  const sameQuote = (row: PaymentIntentRow) => {
    const q = intentQuote(row);
    return q !== null && q.kind === undefined && q.slab === quote.slab && (q.couponCode ?? null) === quote.couponCode && q.totalPaise === quote.totalPaise && row.amountPaise === quote.totalPaise;
  };
  const open = previous.find((row) => isLive(row) && row.mode === "CHECKOUT" && sameQuote(row));
  // Another band, coupon or amount: the older open checkouts end here, so only the checkout for this quote can be paid. A late
  // payment of an ended one is not applied (payments/processing.ts flags it to support for a refund).
  for (const row of allIntents.filter((r) => isLive(r) && r.id !== open?.id)) await expireReplacedCheckout(row.id);
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
      description: `GoKesari shop registration fee${quote.slabLabel ? ` (turnover ${quote.slabLabel})` : ""} — ${shopName}`,
      // Same attempt → same intent; after a failed or expired attempt the count has moved on, so a retry is new.
      idempotencyKey: `shop-draft-fee:${draft.id}:${previous.length}`,
      mode: "CHECKOUT",
      returnPath: "/shop/register",
      // What this checkout is for: the capture applies exactly this band, coupon and amount (onDraftFeeCaptured).
      metadata: { v2Fee: quote },
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
 * 0229 (docs/fee-pay-later-2026-11; flag shop_fee_pay_later_enabled): "Pay later" on the fee step. The fee is quoted
 * exactly as for a payment (band, coupon, GST), open checkouts end, and a request goes to the administrators; the
 * owner carries on with the next steps meanwhile. The shop is created owing the fee; once an administrator approves,
 * the fee no longer holds it back and it is taken from the shop's payouts (services/fee-pay-later.ts). Rejected, the
 * registration returns to this step. Owner only, as for the payment.
 */
export async function requestDraftFeePayLater(
  actor: Actor,
  input: { slab: number | null; couponCode?: string | null; shopName: string; ownerName?: string | null; note?: string | null },
): Promise<{ view: WizardView; amountPaise: number }> {
  const feePayLater = await import("@/server/services/fee-pay-later");
  if (!(await feePayLater.payLaterEnabled())) throw conflict("Pay later is not available. Please pay the registration fee.", { reason: "PAY_LATER_OFF" });
  const draft = await openV2Draft(actor.id);
  if (draft.feePaidAt) throw conflict("The registration fee is already paid.", { reason: "FEE_PAID" });
  const allIntents = await listIntentsFor(DRAFT_FEE_PURPOSE, draft.id);
  if (allIntents.some((row) => isPaid(row))) throw conflict("The registration fee is already paid.", { reason: "FEE_PAID" });
  const latest = await feePayLater.latestPayLaterForDraft(draft.id);
  if (latest?.status === "REJECTED") throw conflict("Your request to pay later was not approved. Please pay the registration fee.", { reason: "PAY_LATER_REJECTED" });
  const view = await toWizardView(draft);
  if (view.nextStep !== "FEE" && !draft.feeDeferredAt) throw conflict("Please finish the earlier steps first.", { reason: "STEP_OPEN", nextStep: view.nextStep });
  const shopName = input.shopName.trim();
  if (shopName.length < 2 || shopName.length > 120) throw validationFailed("Please check the highlighted fields.", { fields: { shopName: "Enter your shop's name." } });
  const ownerName = input.ownerName?.trim() || null;
  if (ownerName !== null && ownerName.length < 2) throw validationFailed("Please check the highlighted fields.", { fields: { ownerName: "Enter the owner's name." } });

  const quote = await v2FeeQuote({ ownerId: actor.id, slab: input.slab, couponCode: input.couponCode ?? null });
  if (quote.totalPaise === 0) return startDraftFeeCheckout(actor, input).then((r) => ({ view: r.view, amountPaise: 0 }));
  // A checkout left open would let a late payment and the pay-later request both stand: it ends here.
  for (const row of allIntents.filter((r) => isLive(r))) await expireReplacedCheckout(row.id);
  const typePatch = draft.feeKind === "WHOLESALE" ? { shopType: undefined } : {};
  const now = new Date();
  await patchDraft(actor.id, { v2ShopName: shopName, ...(ownerName ? { ownerName } : {}), v2Fee: quote, ...typePatch }, { feeKind: null, feePaise: quote.basePaise, feeDeferredAt: draft.feeDeferredAt ?? now });
  const { request, created } = await db.transaction((tx) =>
    // Owner, 28-Nov-2026: the dealer / franchise whose referral code the owner entered decides.
    feePayLater.createPayLaterRequest({ ownerId: actor.id, draftId: draft.id, amountPaise: quote.totalPaise, note: input.note ?? null, shopName, referral: { text: draft.referralCode } }, tx),
  );
  // Asked again with another band or coupon before a decision: the request follows the new quote.
  if (!created && request.status === "REQUESTED" && Number(request.amountPaise) !== quote.totalPaise) {
    await db.update(shopFeePayLater).set({ amountPaise: quote.totalPaise, updatedAt: now }).where(eq(shopFeePayLater.id, request.id));
  }
  if (created) await feePayLater.tellAdminsOfPayLaterRequest(request, shopName);
  return { view: await toWizardView((await findOpenDraft(actor.id))!), amountPaise: quote.totalPaise };
}

/**
 * The quote a draft-fee checkout was opened for (its metadata), or null: a turnover-band quote (27-Nov-2026 on), or
 * a fee-by-kind quote of a checkout opened before (still applied as it was paid).
 */
function intentQuote(row: Pick<PaymentIntentRow, "metadata">): V2FeeQuote | null {
  const q = (row.metadata as { v2Fee?: V2FeeQuote } | null)?.v2Fee;
  if (!q || !Number.isInteger(q.totalPaise) || !Number.isInteger(q.basePaise)) return null;
  if (q.kind === "SHOP" || q.kind === "WHOLESALE") return q;
  return q.kind === undefined && (q.slab === null || Number.isInteger(q.slab)) ? q : null;
}

/** Ends a draft-fee checkout replaced by a newer one (another band, coupon or amount). Already settled: left alone. */
async function expireReplacedCheckout(intentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await lockIntent(tx, intentId);
    if (!row || !isLive(row)) return;
    await transitionIntent(tx, row, "EXPIRED", { source: "SYSTEM", note: "Replaced: the owner opened a checkout for another fee." });
  });
}

/**
 * Capture handler (payments/purpose-handlers.ts), inside the capture transaction: the draft's fee is paid with the kind
 * and amount the checkout was opened for (its metadata) — the draft's fee kind, amount and shop type follow the money,
 * so the shop's fee snapshot and ledger always equal what was captured. Idempotent.
 * Not applied, and flagged to support for a refund (payment.attention): the amount is not the checkout's quote, the
 * draft is gone, or the draft was already paid by another checkout (DEFAULT – confirm with Sanjay).
 */
export async function onDraftFeeCaptured(intent: PaymentIntentRef, client: DbClient): Promise<void> {
  const now = new Date();
  const row = await getPaymentIntentRow(intent.id, client);
  const quote = row ? intentQuote(row) : null;
  const [current] = await client.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, intent.referenceId)).for("update");
  const problem = !current
    ? "draft_not_found"
    : !quote || quote.totalPaise !== intent.amountPaise
      ? "amount_not_the_quote"
      : current.feePaidAt && current.feePaymentIntentId !== intent.id
        ? "already_paid_by_another_payment"
        : null;
  if (current && quote && !problem && !current.feePaidAt) {
    const details: Record<string, unknown> = { ...((current.details as Record<string, unknown> | null) ?? {}), v2Fee: quote };
    // A fee-by-kind checkout opened before 27-Nov-2026 keeps its old meaning (wholesale fee → Wholesale store).
    if (quote.kind === "WHOLESALE") details.shopType = WHOLESALE_SHOP_TYPE;
    else if (quote.kind === "SHOP" && details.shopType === WHOLESALE_SHOP_TYPE) delete details.shopType;
    await client
      .update(shopRegistrationDrafts)
      .set({ feePaidAt: now, feePaymentIntentId: intent.id, feeKind: quote.kind ?? null, feePaise: quote.basePaise, details, updatedAt: now })
      .where(eq(shopRegistrationDrafts.id, current.id));
  }
  if (current && quote && !problem && !current.feePaidAt) {
    // 0229: paid after asking to pay later — the request is no longer needed.
    await client
      .update(shopFeePayLater)
      .set({ status: "CANCELLED", decisionNote: "Fee paid online before the shop was created.", updatedAt: now })
      .where(and(eq(shopFeePayLater.draftId, current.id), inArray(shopFeePayLater.status, ["REQUESTED", "APPROVED"])));
  }
  if (problem) {
    console.error("[onboarding-v2] draft fee capture not applied — refund needed", intent.id, problem);
    if (row) await flagPaymentForSupport(client, row, `Shop registration fee (draft): ${problem.replace(/_/g, " ")} — not applied, refund it`, `draft-fee:${intent.id}`);
  }
  await recordAudit(
    {
      actorId: intent.userId,
      actorRole: null,
      action: AUDIT_ACTIONS.SHOP_REGISTRATION_DRAFT_FEE_PAID,
      entityType: "shop_registration_draft",
      entityId: intent.referenceId,
      newValue: { intentId: intent.id, amountPaise: intent.amountPaise, slab: quote?.slab ?? null, couponCode: quote?.couponCode ?? null, kind: quote?.kind ?? null, gateway: intent.gateway, applied: !problem, problem },
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
 * upload it after go-live (My shop → Documents). With flag flow_f5 (docs/flows-v3/wave3.md) it is copied there
 * (flows/f5-licences.ts), so the register and its reminders count it as given.
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
 * then an operator's check (never a hold on go-live). Later: the promise (any licence, must-have ones included — owner,
 * 27-Nov-2026), which the existing document follow-up chases once the shop is live (documents_promised_at).
 */
export async function saveLicenceEntry(actor: Actor, input: LicenceEntryInput): Promise<WizardView> {
  const draft = await openV2Draft(actor.id);
  const view = await toWizardView(draft);
  // 0229: "Pay later" asked (or approved) passes the fee step as a payment does.
  if ((!view.v2?.fee.paid && !draft.feeDeferredAt) || !view.shopType) throw conflict("Please pay the fee and choose your shop type first.", { reason: "STEP_OPEN", nextStep: view.nextStep });
  const licence = view.v2!.licences.find((l) => l.key === input.licenceKey);
  if (!licence) throw notFound("Licence");
  const now = new Date();
  let status: LicenceEntryStatus;
  let statusReason: string | null = null;
  let verifyRef: string | null = null;
  let fileRef: string | null = null;
  let number = clean(input.number, 60);
  const ocr = input.ocr ?? null;

  if (input.option === "LATER") {
    // Owner, 27-Nov-2026 (replaces DEFAULT #12 and, for v2, the 21-Nov "FSSAI before live" rule): every licence —
    // must-have ones and FSSAI included — may be promised within the documents follow-up's period.
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
export async function afterV2ShopCreated(shop: Shop, actor: Actor): Promise<void> {
  // 0229 (docs/fee-pay-later-2026-11): a "pay later" request made on the draft now belongs to the shop (also linked
  // on first read if this fails).
  const [draftRow] = await db.select({ id: shopRegistrationDrafts.id }).from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.shopId, shop.id)).limit(1);
  if (draftRow) {
    await (await import("@/server/services/fee-pay-later"))
      .linkPayLaterToShop(draftRow.id, shop.id)
      .catch((error: unknown) => console.error("[onboarding-v2] pay-later request not linked yet", shop.id, error));
  }
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
  // The fee paid on the draft: on the shop's ledger now; if this fails it is retried (ensureV2FeeOnLedger).
  await ensureV2FeeOnLedger(shop.id).catch((error: unknown) => console.error("[onboarding-v2] draft fee not on the shop's ledger yet (retried)", shop.id, error));
  // docs/flows-v3 (flag flow_f14): the shop's prepaid wallet exists from the start (zero balance; idempotent).
  // Off: it is created on first use, as before.
  if (await isFeatureEnabled("flow_f14").catch(() => false)) {
    await getOrCreateShopWallet(shop.id).catch((error: unknown) => console.error("[onboarding-v2] shop wallet not created yet (created on first use)", shop.id, error));
  }
  // docs/flows-v3/wave3.md (flag flow_f5): the licences given at registration go into the shop's licence register.
  await (await import("@/server/flows/f5-licences")).copyRegistrationLicencesSafely(shop.id);
}

/**
 * The fee paid on a v2 draft, on its shop's immutable ledger (ONLINE, the gateway's payment id) — the same capture
 * step a shop fee uses, so fee status, subscription and auto-approval evidence follow. Idempotent (one ledger row per
 * gateway payment) and retried until it holds: at shop creation, on every wizard page load, before go-live, in
 * autoApproveShopIfReady and by the cron safety net (sweepV2FeeLedger). True when the shop owes nothing more.
 * Go-live itself still waits for the agreement (autoApproveShopIfReady refuses while it is pending).
 */
export async function ensureV2FeeOnLedger(shopId: string): Promise<boolean> {
  const [draft] = await db
    .select({ intentId: shopRegistrationDrafts.feePaymentIntentId, feePaidAt: shopRegistrationDrafts.feePaidAt })
    .from(shopRegistrationDrafts)
    .where(and(eq(shopRegistrationDrafts.shopId, shopId), eq(shopRegistrationDrafts.flowVersion, "v2")))
    .limit(1);
  if (!draft?.intentId || !draft.feePaidAt) return false;
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) return false;
  const { registrationFeeDue } = await import("@/server/services/registration-fee-payment");
  if (registrationFeeDue(shop) === 0) return true;
  const intent = await getPaymentIntentRow(draft.intentId);
  if (!intent || !isPaid(intent)) return false;
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
  );
  const [after] = await db.select().from(shops).where(eq(shops.id, shopId));
  return Boolean(after && registrationFeeDue(after) === 0);
}

/** Cron safety net (every 5 minutes): v2 shops whose draft fee is paid but not yet on the shop's ledger. */
export async function sweepV2FeeLedger(limit = 100): Promise<{ checked: number; fixed: number; failed: number }> {
  const rows = await db
    .select({ shopId: shops.id })
    .from(shopRegistrationDrafts)
    .innerJoin(shops, eq(shops.id, shopRegistrationDrafts.shopId))
    .where(
      and(
        eq(shopRegistrationDrafts.flowVersion, "v2"),
        isNotNull(shopRegistrationDrafts.feePaidAt),
        isNotNull(shopRegistrationDrafts.feePaymentIntentId),
        eq(shops.status, "PENDING_APPROVAL"),
        sql`${shops.amountPaidPaise} < coalesce(${shops.registrationFeePaise}, 0)`,
      ),
    )
    .limit(limit);
  let fixed = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      if (await ensureV2FeeOnLedger(r.shopId)) fixed += 1;
    } catch (error) {
      failed += 1;
      console.error("[onboarding-v2] fee ledger safety net failed", r.shopId, error);
    }
  }
  return { checked: rows.length, fixed, failed };
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
  // The fee the owner paid must be on the shop's ledger before go-live (retried here; an error lets the owner try again).
  await ensureV2FeeOnLedger(draft.shopId);
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
  // docs/flows-v3/wave3.md (flag flow_f4): the accepted agreement is e-mailed now, in English, Marathi and Hindi.
  await (await import("@/server/flows/f4-onboarding")).emailAgreementOnAcceptance(draft.shopId, now);
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
 * Owner, 27-Nov-2026: the team's check is for checking only — no licence entry holds a v2 shop's go-live (the shop
 * goes live on its GST / PAN and fee). A rejected licence is no longer "given": the documents follow-up chases it.
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
  // docs/flows-v3/wave3.md (flag flow_f5): the register copy follows the team's decision (approved / rejected).
  await (await import("@/server/flows/f5-licences")).copyRegistrationLicencesSafely(entry.shopId);
  if (decision.approve) await (await import("./document-reactivation")).afterShopDocumentGiven(entry.shopId);
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
