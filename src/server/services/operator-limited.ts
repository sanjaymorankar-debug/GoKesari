/**
 * Operator-Limited shop onboarding (batch-2026-10 WS-D, F8.4.2 / RBAC-003).
 *
 * An OPERATOR_LIMITED user may do exactly this, and only for the shops THEY
 * onboarded (shops.onboarded_by_user_id):
 *
 *   1. startOwnerConsent    — the owner's email gets a code (OTP purpose
 *                              SHOP_ONBOARDING_CONSENT, bound to this operator);
 *   2. verifyOwnerConsent   — the owner reads the code out; the operator enters
 *                              it. Only now is there an owner account to act for
 *                              (found by the email, or created with it verified);
 *   3. submitOnboardedShop  — the registration, with the referral code, under
 *                              that owner (PENDING_APPROVAL as always);
 *   4. requestRegistrationFee — a payment link emailed to the owner (LINK) or a
 *                              checkout to pay in session (CHECKOUT), through the
 *                              payment-intent gateway (F1.7.3);
 *   5. onShopRegistrationFeeCaptured — the capture handler (purpose-handlers.ts):
 *                              the fee is recorded on the shop's ledger in the
 *                              capture transaction; after commit the existing
 *                              auto-approval rule runs. A fee that fails or whose
 *                              link expires leaves the shop PENDING_APPROVAL for
 *                              an administrator, who is told (sweepOnboardingFees);
 *   6. documents            — view and approve / reject (with a reason) the seller
 *                              documents of those shops, through the existing
 *                              seller-verification decision.
 *
 * No finance, payouts, settings or other operators' shops: the role's capability
 * list (authz/permissions.ts) has none of those, and every function here checks
 * the shop's onboarded_by_user_id. Every action — including refusals — is
 * written to the audit log.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import { maskEmailAddress, normalizeEmail } from "@/lib/contact";
import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { decryptBytes } from "@/lib/pan-crypto";
import { SELLER_DOC_LABELS, type SellerDocType, type SellerVerificationStatus } from "@/lib/kyc/doc-formats";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import {
  sellerVerificationFiles,
  sellerVerifications,
  shopOnboardingSessions,
  shopPayments,
  shops,
  users,
  wallets,
  type Shop,
  type ShopOnboardingSession,
  type UserRole,
} from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { requestShopOnboardingConsentOtp, verifyShopOnboardingConsentOtp } from "@/server/otp/service";
import { createPaymentIntent, getPaymentIntent, type PaymentIntentRef } from "@/server/payments/intents";
import { AUDIT_ACTIONS, recordAudit, type AuditAction } from "./audit";
import { assertRegistrationReferralCode, attributeRegistrationReferral } from "./referral-requests";
import { adminDecideVerification, getShopVerificationSummary, type SellerVerificationView } from "./seller-verification";
import { getRule } from "./settings";
import { recordPayment } from "./shop-payments";
import { autoApproveShopIfReady, registerShop, type RegisterShopInput } from "./shops";

export interface OperatorActor {
  id: string;
  role: UserRole;
  name?: string | null;
  email?: string | null;
}

/** The roles that work here. ADMIN sees every onboarded shop; OPERATOR_LIMITED only their own. */
const WORKS_HERE: readonly UserRole[] = ["OPERATOR_LIMITED", "ADMIN"];

function assertRole(actor: OperatorActor): void {
  if (!WORKS_HERE.includes(actor.role)) throw forbidden("Only an Operator (Limited) can onboard shops here.");
}

async function audit(
  actor: OperatorActor | null,
  action: AuditAction,
  entityType: string,
  entityId: string | null,
  newValue: Record<string, unknown>,
  client: DbClient = db,
  ip?: string | null,
): Promise<void> {
  await recordAudit(
    { actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action, entityType, entityId, newValue, ipAddress: ip ?? null },
    client,
  );
}

/** May this actor work on this shop? Refusals are audited (who tried to reach whose shop). */
async function assertOwnShop(shopId: string, actor: OperatorActor): Promise<Shop> {
  assertRole(actor);
  const shop = await db.query.shops.findFirst({ where: and(eq(shops.id, shopId), isNull(shops.deletedAt)) });
  if (!shop) throw notFound("Shop");
  if (actor.role !== "ADMIN" && shop.onboardedByUserId !== actor.id) {
    await audit(actor, AUDIT_ACTIONS.OPLTD_ACCESS_DENIED, "shop", shopId, { reason: "not_onboarded_by_actor" });
    // The same answer as a missing shop: another operator's shop is not even confirmed to exist.
    throw notFound("Shop");
  }
  return shop;
}

async function loadOwnSession(sessionId: string, actor: OperatorActor): Promise<ShopOnboardingSession> {
  assertRole(actor);
  const [session] = await db.select().from(shopOnboardingSessions).where(eq(shopOnboardingSessions.id, sessionId));
  if (!session || (actor.role !== "ADMIN" && session.operatorId !== actor.id)) throw notFound("Onboarding");
  return session;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

function consentEmail(operatorName: string) {
  return (code: string, expiryMinutes: number) => ({
    subject: `${code} — your code to let ${operatorName} register your shop on GoKesari`,
    text:
      `${operatorName}, a GoKesari operator, is registering your shop on GoKesari for you.\n\n` +
      `If you agree, tell them this code: ${code}\n\n` +
      `It works once and expires in ${expiryMinutes} minutes. If you did not ask for this, do not share the code — nothing will be registered without it.\n`,
    html:
      `<p><strong>${escapeHtml(operatorName)}</strong>, a GoKesari operator, is registering your shop on GoKesari for you.</p>` +
      `<p>If you agree, tell them this code:</p>` +
      `<p style="font-size:28px;letter-spacing:6px;font-weight:600">${escapeHtml(code)}</p>` +
      `<p style="color:#666;font-size:12px">It works once and expires in ${expiryMinutes} minutes. ` +
      `If you did not ask for this, do not share the code — nothing will be registered without it.</p>`,
  });
}

const operatorName = (actor: OperatorActor) => actor.name?.trim() || "A GoKesari operator";

/* ------------------------------------------------------------ 1. consent */

export async function startOwnerConsent(
  input: { ownerEmail: string },
  actor: OperatorActor,
  ip: string | null = null,
): Promise<{ sessionId: string; maskedEmail: string; expiryMinutes: number; resendAfterSeconds: number }> {
  assertRole(actor);
  const email = normalizeEmail(input.ownerEmail);
  const sent = await requestShopOnboardingConsentOtp({ email, operatorId: actor.id, ip, render: consentEmail(operatorName(actor)) });
  const [session] = await db
    .insert(shopOnboardingSessions)
    .values({ operatorId: actor.id, ownerEmail: email, status: "OTP_SENT" })
    .returning();
  await audit(actor, AUDIT_ACTIONS.OPLTD_OWNER_OTP_SENT, "shop_onboarding", session.id, { ownerEmail: maskEmailAddress(email) }, db, ip);
  return { sessionId: session.id, maskedEmail: sent.maskedEmail, expiryMinutes: sent.expiryMinutes, resendAfterSeconds: sent.resendAfterSeconds };
}

/** The owner's account for the verified email: the existing one, or a new customer account (email verified by the code). */
async function ownerAccountFor(email: string): Promise<{ id: string; created: boolean }> {
  const [existing] = await db.select().from(users).where(and(eq(users.email, email), isNull(users.deletedAt)));
  if (existing) {
    if (existing.status !== "ACTIVE") throw forbidden("The owner's account is suspended or closed, so a shop cannot be registered for it.");
    if (!existing.emailVerified) await db.update(users).set({ emailVerified: new Date(), updatedAt: new Date() }).where(eq(users.id, existing.id));
    return { id: existing.id, created: false };
  }
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(users).values({ email, emailVerified: new Date(), role: "CUSTOMER" }).returning({ id: users.id });
    await tx.insert(wallets).values({ userId: row.id }).onConflictDoNothing();
    return { id: row.id, created: true };
  });
}

export async function verifyOwnerConsent(
  sessionId: string,
  input: { code: string },
  actor: OperatorActor,
  ip: string | null = null,
): Promise<{ sessionId: string; ownerUserId: string; consentExpiresAt: Date; newOwnerAccount: boolean }> {
  const session = await loadOwnSession(sessionId, actor);
  if (session.status !== "OTP_SENT") throw conflict("The owner's code has already been entered for this onboarding.");
  try {
    await verifyShopOnboardingConsentOtp({ email: session.ownerEmail, code: input.code, operatorId: session.operatorId, ip });
  } catch (error) {
    await audit(actor, AUDIT_ACTIONS.OPLTD_OWNER_OTP_FAILED, "shop_onboarding", session.id, {
      ownerEmail: maskEmailAddress(session.ownerEmail),
      reason: error instanceof Error ? error.message : "invalid",
    }, db, ip);
    throw error;
  }
  const owner = await ownerAccountFor(session.ownerEmail);
  const rule = await getRule("operatorLimited");
  const consentExpiresAt = new Date(Date.now() + rule.consentValidMinutes * 60_000);
  await db
    .update(shopOnboardingSessions)
    .set({ status: "OWNER_VERIFIED", otpVerifiedAt: new Date(), consentExpiresAt, ownerUserId: owner.id, updatedAt: new Date() })
    .where(eq(shopOnboardingSessions.id, session.id));
  await audit(actor, AUDIT_ACTIONS.OPLTD_OWNER_VERIFIED, "shop_onboarding", session.id, {
    ownerEmail: maskEmailAddress(session.ownerEmail),
    ownerUserId: owner.id,
    newOwnerAccount: owner.created,
  }, db, ip);
  return { sessionId: session.id, ownerUserId: owner.id, consentExpiresAt, newOwnerAccount: owner.created };
}

/* -------------------------------------------------------- 2. registration */

/** What the operator may fill in: the ordinary registration, never the fee, date or owner. */
export type OnboardShopInput = Omit<RegisterShopInput, "ownerId" | "registrationFeePaise" | "registrationDate" | "referralCode"> & {
  referralCode?: string | null;
};

export async function submitOnboardedShop(
  sessionId: string,
  input: OnboardShopInput,
  actor: OperatorActor,
): Promise<{ shop: Shop; sessionId: string }> {
  const session = await loadOwnSession(sessionId, actor);
  if (session.status !== "OWNER_VERIFIED" || !session.ownerUserId) {
    throw forbidden("The owner has not confirmed this onboarding: send the code to the owner's email and enter it first.");
  }
  if (!session.consentExpiresAt || session.consentExpiresAt.getTime() <= Date.now()) {
    throw forbidden("The owner's confirmation has expired. Send a new code to the owner.");
  }
  // Checked before anything is saved, as the self-service form does.
  const referralCode = await assertRegistrationReferralCode(input.referralCode ?? null);

  const { referralCode: _drop, ...details } = input;
  void _drop;
  const sanitized = details as RegisterShopInput & Record<string, unknown>;
  delete sanitized.ownerId;
  delete sanitized.registrationFeePaise;
  delete sanitized.registrationDate;

  let shop: Shop;
  try {
    // `privileged` only so the shop is registered under the verified owner; the
    // fee override, registration date and referral path of registerShop are not
    // used (stripped above).
    shop = await registerShop({ ...sanitized, ownerId: session.ownerUserId }, actor, { privileged: true });
  } catch (error) {
    // A duplicate names the other shop to staff; an Operator-Limited user must not learn about shops that are not theirs.
    if (error instanceof AppError && error.code === "CONFLICT" && error.details?.reason === "DUPLICATE_SHOP") {
      const { matchedShopId: _a, matchedRegistrationNumber: _b, ...rest } = error.details;
      void _a;
      void _b;
      throw conflict(error.message, rest);
    }
    throw error;
  }

  await db
    .update(shops)
    .set({ onboardedByUserId: actor.id, updatedAt: new Date() })
    .where(and(eq(shops.id, shop.id), or(isNull(shops.onboardedByUserId), eq(shops.onboardedByUserId, actor.id))));
  if (referralCode) await attributeRegistrationReferral(shop, referralCode, actor);

  const [after] = await db.select().from(shops).where(eq(shops.id, shop.id));
  const feeDue = Math.max(0, (after.registrationFeePaise ?? 0) - after.amountPaidPaise);
  await db
    .update(shopOnboardingSessions)
    .set({
      status: "SHOP_SUBMITTED",
      shopId: shop.id,
      referralCode,
      feeAmountPaise: feeDue,
      feeStatus: feeDue === 0 ? "WAIVED" : "NONE",
      updatedAt: new Date(),
    })
    .where(eq(shopOnboardingSessions.id, session.id));

  await audit(actor, AUDIT_ACTIONS.OPLTD_SHOP_SUBMITTED, "shop", shop.id, {
    sessionId: session.id,
    ownerUserId: session.ownerUserId,
    name: after.name,
    shopType: after.shopType,
    registrationNumber: after.registrationNumber,
    referralCode,
    feeDuePaise: feeDue,
  });
  await emitEvent({
    type: "shop.onboarded_by_operator",
    subjectId: shop.id,
    actor: { id: actor.id, role: actor.role },
    payload: { shopName: after.name, ownerId: after.ownerId, operatorName: operatorName(actor), registrationNumber: after.registrationNumber },
    idempotencyKey: `shop-onboarded:${shop.id}`,
  });
  if (feeDue === 0) {
    await autoApproveShopIfReady(shop.id).catch((e) => console.error("[operator-limited] auto-approval check failed", shop.id, e));
  }
  return { shop: after, sessionId: session.id };
}

/* ------------------------------------------------------- 3. registration fee */

export interface FeeRequestResult {
  sessionId: string;
  mode: "LINK" | "CHECKOUT";
  amountPaise: number;
  feeStatus: ShopOnboardingSession["feeStatus"];
  linkUrl: string | null;
  checkoutUrl: string | null;
  expiresAt: Date | null;
}

export async function requestRegistrationFee(
  sessionId: string,
  input: { mode: "LINK" | "CHECKOUT" },
  actor: OperatorActor,
): Promise<FeeRequestResult> {
  const session = await loadOwnSession(sessionId, actor);
  if (!session.shopId || !session.ownerUserId) throw conflict("Register the shop before asking for the fee.");
  const shop = await assertOwnShop(session.shopId, actor);
  const due = Math.max(0, (shop.registrationFeePaise ?? 0) - shop.amountPaidPaise);
  if (due === 0 || shop.feePaymentStatus === "PAID") {
    await db.update(shopOnboardingSessions).set({ feeStatus: due === 0 && shop.feePaymentStatus !== "PAID" ? "WAIVED" : "PAID", updatedAt: new Date() }).where(eq(shopOnboardingSessions.id, session.id));
    throw conflict("Nothing is due: the registration fee is already settled.");
  }
  // A live request is reused: pressing the button twice never creates two charges.
  if (session.feeStatus === "PENDING" && session.feeMode === input.mode && session.feeExpiresAt && session.feeExpiresAt.getTime() > Date.now()) {
    return {
      sessionId: session.id,
      mode: input.mode,
      amountPaise: session.feeAmountPaise ?? due,
      feeStatus: session.feeStatus,
      linkUrl: session.feeLinkUrl,
      checkoutUrl: input.mode === "CHECKOUT" ? session.feeLinkUrl : null,
      expiresAt: session.feeExpiresAt,
    };
  }

  const [owner] = await db.select().from(users).where(eq(users.id, session.ownerUserId));
  const rule = await getRule("operatorLimited");
  const expiresAt = new Date(Date.now() + rule.paymentLinkExpiryHours * 3_600_000);
  const created = await createPaymentIntent({
    purpose: "SHOP_REGISTRATION_FEE",
    referenceId: shop.id,
    userId: session.ownerUserId,
    amountPaise: due,
    customer: { id: session.ownerUserId, name: owner?.name ?? shop.ownerName, email: owner?.email ?? session.ownerEmail, phone: shop.phone },
    description: `GoKesari registration fee — ${shop.name}`,
    // Same request → same intent (a double press charges once); a retry after a failed or expired one, or a
    // switch of mode, follows a different previous intent and so gets a fresh one.
    idempotencyKey: `shop-registration-fee:${session.id}:${input.mode}:${session.feeIntentId ?? "first"}`,
    mode: input.mode,
    returnPath: "/shop",
  });
  const checkoutUrl = created.checkout ? (created.checkout.kind === "HOSTED_URL" ? created.checkout.url : created.checkout.url ?? null) : null;
  const linkUrl = input.mode === "LINK" ? created.linkUrl : checkoutUrl;

  await db
    .update(shopOnboardingSessions)
    .set({
      status: "FEE_PENDING",
      feeMode: input.mode,
      feeStatus: "PENDING",
      feeAmountPaise: due,
      feeIntentId: created.intent.id,
      feeLinkUrl: linkUrl,
      feeExpiresAt: expiresAt,
      feeFailureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(shopOnboardingSessions.id, session.id));
  await audit(actor, AUDIT_ACTIONS.OPLTD_FEE_REQUESTED, "shop", shop.id, {
    sessionId: session.id,
    mode: input.mode,
    amountPaise: due,
    intentId: created.intent.id,
    expiresAt: expiresAt.toISOString(),
  });
  if (input.mode === "LINK" && linkUrl) {
    await emitEvent({
      type: "shop.registration_fee_link_sent",
      subjectId: shop.id,
      actor: { id: actor.id, role: actor.role },
      payload: {
        shopName: shop.name,
        ownerId: session.ownerUserId,
        amountPaise: due,
        link: linkUrl,
        expiresAt: expiresAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }),
      },
      idempotencyKey: `shop-fee-link:${created.intent.id}`,
    });
  }
  return { sessionId: session.id, mode: input.mode, amountPaise: due, feeStatus: "PENDING", linkUrl: input.mode === "LINK" ? linkUrl : null, checkoutUrl: input.mode === "CHECKOUT" ? checkoutUrl : null, expiresAt };
}

/**
 * CAPTURED handler for purpose SHOP_REGISTRATION_FEE (purpose-handlers.ts).
 * Runs inside the payment service's capture transaction: the fee is written to
 * the shop's immutable ledger (shop_payments, method ONLINE) with the capture.
 * Idempotent — a replayed capture finds its ledger row and does nothing. The
 * auto-approval check runs after the commit (it locks the shop row this
 * transaction holds, so it must not run inside it).
 */
export async function onShopRegistrationFeeCaptured(intent: PaymentIntentRef, client: DbClient): Promise<void> {
  const transactionId = `${intent.gateway}:${intent.gatewayPaymentId ?? intent.id}`;
  const [shop] = await client.select().from(shops).where(eq(shops.id, intent.referenceId));
  if (!shop) {
    await recordAudit({ action: AUDIT_ACTIONS.OPLTD_FEE_PAID, entityType: "payment_intent", entityId: intent.id, newValue: { problem: "shop_not_found", referenceId: intent.referenceId } }, client);
    return;
  }
  const [already] = await client
    .select({ id: shopPayments.id })
    .from(shopPayments)
    .where(and(eq(shopPayments.shopId, shop.id), eq(shopPayments.transactionId, transactionId)));
  if (already) return;

  const recorded = await recordPayment(
    {
      shopId: shop.id,
      paymentType: "REGISTRATION_FEE",
      amountPaise: intent.amountPaise,
      method: "ONLINE",
      transactionId,
      note: `Registration fee paid online (payment intent ${intent.id}, ${intent.gateway}${intent.gateway === "SANDBOX" ? " — test payment" : ""}).`,
    },
    { id: intent.userId ?? shop.ownerId, role: "SHOP_OWNER" },
    client,
  );
  const [session] = await client
    .update(shopOnboardingSessions)
    .set({ status: "FEE_PAID", feeStatus: "PAID", feeFailureReason: null, updatedAt: new Date() })
    .where(eq(shopOnboardingSessions.shopId, shop.id))
    .returning();
  await recordAudit(
    {
      actorId: null,
      action: AUDIT_ACTIONS.OPLTD_FEE_PAID,
      entityType: "shop",
      entityId: shop.id,
      newValue: { intentId: intent.id, amountPaise: intent.amountPaise, reference: recorded.payment.reference, feePaymentStatus: recorded.feePaymentStatus, sessionId: session?.id ?? null },
    },
    client,
  );
  const finish = () =>
    void finishFeeCapture(shop.id, intent.id).catch((e) => console.error("[operator-limited] after-capture step failed", shop.id, e));
  if (client === db) finish();
  // Inside the capture transaction: run once it has committed (the sweep is the safety net).
  else setTimeout(finish, 2_000).unref?.();
}

/** After the fee's commit: the existing auto-approval rule, then the people involved are told. Idempotent. */
export async function finishFeeCapture(shopId: string, intentId: string): Promise<{ approved: boolean }> {
  const approved = await autoApproveShopIfReady(shopId);
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) return { approved: false };
  const [session] = await db.select().from(shopOnboardingSessions).where(eq(shopOnboardingSessions.shopId, shopId));
  if (session && shop.status === "APPROVED" && session.status !== "COMPLETED") {
    await db.update(shopOnboardingSessions).set({ status: "COMPLETED", updatedAt: new Date() }).where(eq(shopOnboardingSessions.id, session.id));
  }
  await emitEvent({
    type: "shop.registration_fee_paid",
    subjectId: shopId,
    payload: { shopName: shop.name, ownerId: shop.ownerId, operatorId: session?.operatorId ?? null, amountPaise: session?.feeAmountPaise ?? shop.amountPaidPaise, approved: shop.status === "APPROVED" },
    idempotencyKey: `shop-fee-paid:${shopId}:${intentId}`,
  });
  return { approved: approved || shop.status === "APPROVED" };
}

/**
 * The fee did not succeed (the gateway says FAILED / EXPIRED, or the link ran
 * out): the shop stays PENDING_APPROVAL — the existing status — and goes to an
 * administrator, who is told at once with the operator. Idempotent per intent.
 */
export async function onShopRegistrationFeeFailed(shopId: string, reason: string, status: "FAILED" | "EXPIRED" = "FAILED"): Promise<boolean> {
  const [session] = await db
    .update(shopOnboardingSessions)
    .set({ status: "PENDING_ADMIN", feeStatus: status, feeFailureReason: reason, updatedAt: new Date() })
    .where(and(eq(shopOnboardingSessions.shopId, shopId), eq(shopOnboardingSessions.feeStatus, "PENDING")))
    .returning();
  if (!session) return false;
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  const [operator] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, session.operatorId));
  await recordAudit({
    action: AUDIT_ACTIONS.OPLTD_FEE_FAILED,
    entityType: "shop",
    entityId: shopId,
    newValue: { sessionId: session.id, intentId: session.feeIntentId, status, reason, shopStatus: shop?.status ?? null },
  });
  if (shop) {
    await emitEvent({
      type: "shop.registration_fee_failed",
      subjectId: shopId,
      payload: { shopName: shop.name, operatorId: session.operatorId, operatorName: operator?.name ?? operator?.email ?? "an operator", reason },
      idempotencyKey: `shop-fee-failed:${shopId}:${session.feeIntentId ?? "none"}`,
    });
  }
  return true;
}

/**
 * Safety net, run by /api/cron/operator-onboarding (and on "refresh" from the
 * payments page): asks the payment service for each pending fee's state, sends
 * failed / expired ones to an administrator, and finishes captured ones whose
 * after-commit step did not run.
 */
export async function sweepOnboardingFees(options: { sessionIds?: string[]; now?: Date } = {}): Promise<{ checked: number; failed: number; expired: number; finished: number }> {
  const now = options.now ?? new Date();
  const pending = await db
    .select()
    .from(shopOnboardingSessions)
    .where(
      and(
        isNotNull(shopOnboardingSessions.shopId),
        or(eq(shopOnboardingSessions.feeStatus, "PENDING"), eq(shopOnboardingSessions.status, "FEE_PAID")),
        options.sessionIds?.length ? inArray(shopOnboardingSessions.id, options.sessionIds) : undefined,
      ),
    )
    .limit(200);
  const out = { checked: pending.length, failed: 0, expired: 0, finished: 0 };
  for (const s of pending) {
    if (s.status === "FEE_PAID") {
      if (s.feeIntentId) {
        const r = await finishFeeCapture(s.shopId!, s.feeIntentId);
        if (r.approved) out.finished += 1;
      }
      continue;
    }
    let intent: PaymentIntentRef | null = null;
    if (s.feeIntentId) {
      try {
        intent = await getPaymentIntent(s.feeIntentId);
      } catch (error) {
        console.error("[operator-limited] could not read payment intent", s.feeIntentId, error);
      }
    }
    if (intent && (intent.status === "FAILED" || intent.status === "EXPIRED")) {
      if (await onShopRegistrationFeeFailed(s.shopId!, intent.status === "FAILED" ? "the payment failed" : "the payment expired", intent.status)) {
        if (intent.status === "FAILED") out.failed += 1;
        else out.expired += 1;
      }
    } else if ((!intent || !["CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(intent.status)) && s.feeExpiresAt && s.feeExpiresAt.getTime() <= now.getTime()) {
      if (await onShopRegistrationFeeFailed(s.shopId!, "the payment link expired without payment", "EXPIRED")) out.expired += 1;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 4. lists */

export interface OnboardedShopRow {
  shopId: string;
  name: string;
  registrationNumber: string | null;
  status: string;
  lifecycleStatus: string;
  feePaymentStatus: string;
  registrationFeePaise: number | null;
  amountPaidPaise: number;
  createdAt: Date;
  session: Pick<ShopOnboardingSession, "id" | "status" | "feeStatus" | "feeMode" | "feeLinkUrl" | "feeExpiresAt" | "feeFailureReason" | "ownerEmail"> | null;
}

export async function listMyOnboardedShops(actor: OperatorActor, options: { audit?: boolean } = {}): Promise<OnboardedShopRow[]> {
  assertRole(actor);
  const rows = await db
    .select({ shop: shops, session: shopOnboardingSessions })
    .from(shops)
    .leftJoin(shopOnboardingSessions, eq(shopOnboardingSessions.shopId, shops.id))
    .where(
      and(
        isNull(shops.deletedAt),
        actor.role === "ADMIN" ? isNotNull(shops.onboardedByUserId) : eq(shops.onboardedByUserId, actor.id),
      ),
    )
    .orderBy(desc(shops.createdAt))
    .limit(500);
  if (options.audit !== false) await audit(actor, AUDIT_ACTIONS.OPLTD_SHOPS_VIEWED, "shop", null, { count: rows.length });
  return rows.map(({ shop, session }) => ({
    shopId: shop.id,
    name: shop.name,
    registrationNumber: shop.registrationNumber,
    status: shop.status,
    lifecycleStatus: shop.lifecycleStatus,
    feePaymentStatus: shop.feePaymentStatus,
    registrationFeePaise: shop.registrationFeePaise,
    amountPaidPaise: shop.amountPaidPaise,
    createdAt: shop.createdAt,
    session: session
      ? {
          id: session.id,
          status: session.status,
          feeStatus: session.feeStatus,
          feeMode: session.feeMode,
          feeLinkUrl: session.feeLinkUrl,
          feeExpiresAt: session.feeExpiresAt,
          feeFailureReason: session.feeFailureReason,
          ownerEmail: maskEmailAddress(session.ownerEmail),
        }
      : null,
  }));
}

/** Onboardings still open (code sent, owner verified, shop not yet submitted) — to resume them. */
export async function listOpenOnboardings(actor: OperatorActor): Promise<ShopOnboardingSession[]> {
  assertRole(actor);
  return db
    .select()
    .from(shopOnboardingSessions)
    .where(
      and(
        actor.role === "ADMIN" ? undefined : eq(shopOnboardingSessions.operatorId, actor.id),
        inArray(shopOnboardingSessions.status, ["OTP_SENT", "OWNER_VERIFIED"]),
        lt(sql`now() - ${shopOnboardingSessions.createdAt}`, sql`interval '2 days'`),
      ),
    )
    .orderBy(desc(shopOnboardingSessions.createdAt))
    .limit(50);
}

/* ------------------------------------------------------------- 5. documents */

/** A shop's documents for its shop type (FSSAI for food shops, …), as the admin review screen has them. */
export async function getShopDocumentsForOperator(shopId: string, actor: OperatorActor) {
  const shop = await assertOwnShop(shopId, actor);
  if (!can(actor.role, PERMISSIONS.OPERATOR_LIMITED_VERIFY_DOCS)) throw forbidden("You cannot review documents.");
  // Read through the reviewer view; access to THIS shop was checked above.
  const summary = await getShopVerificationSummary(shopId, { id: actor.id, role: "OPERATOR" });
  await audit(actor, AUDIT_ACTIONS.OPLTD_DOCUMENTS_VIEWED, "shop", shopId, { documents: summary.documents.length, missing: summary.missing });
  return { shop: { id: shop.id, name: shop.name, shopType: shop.shopType, status: shop.status, lifecycleStatus: shop.lifecycleStatus }, ...summary };
}

export interface DocumentToVerify {
  verificationId: string;
  shopId: string;
  shopName: string;
  docType: SellerDocType;
  label: string;
  status: SellerVerificationStatus;
  numberMasked: string | null;
  updatedAt: Date;
}

/** Documents waiting for a decision on the actor's own shops. */
export async function listDocumentsToVerify(actor: OperatorActor): Promise<DocumentToVerify[]> {
  assertRole(actor);
  const rows = await db
    .select({ v: sellerVerifications, shopName: shops.name })
    .from(sellerVerifications)
    .innerJoin(shops, eq(shops.id, sellerVerifications.shopId))
    .where(
      and(
        isNull(shops.deletedAt),
        actor.role === "ADMIN" ? isNotNull(shops.onboardedByUserId) : eq(shops.onboardedByUserId, actor.id),
        inArray(sellerVerifications.status, ["PENDING", "MANUAL_REVIEW"]),
      ),
    )
    .orderBy(sellerVerifications.updatedAt)
    .limit(200);
  return rows.map(({ v, shopName }) => ({
    verificationId: v.id,
    shopId: v.shopId,
    shopName,
    docType: v.docType,
    label: SELLER_DOC_LABELS[v.docType],
    status: v.status,
    numberMasked: v.numberMasked,
    updatedAt: v.updatedAt,
  }));
}

/** Approve or reject (reason required to reject) one document of an own shop. */
export async function decideShopDocument(
  verificationId: string,
  input: { decision: "approve" | "reject"; reason: string },
  actor: OperatorActor,
): Promise<SellerVerificationView> {
  assertRole(actor);
  if (!can(actor.role, PERMISSIONS.OPERATOR_LIMITED_VERIFY_DOCS)) throw forbidden("You cannot review documents.");
  const [row] = await db.select().from(sellerVerifications).where(eq(sellerVerifications.id, verificationId));
  if (!row) throw notFound("Document");
  await assertOwnShop(row.shopId, actor);
  if (input.decision === "reject" && input.reason.trim().length < 3) throw validationFailed("Give the reason the document is rejected.");
  const view = await adminDecideVerification(verificationId, input, { id: actor.id, role: actor.role }, { scopedReviewer: true });
  await audit(actor, AUDIT_ACTIONS.OPLTD_DOCUMENT_DECIDED, "shop", row.shopId, {
    verificationId,
    docType: row.docType,
    decision: input.decision,
    reason: input.reason.trim() || null,
    from: row.status,
    to: view.status,
  });
  return view;
}

/** One uploaded document file of an own shop (audited). */
export async function getShopDocumentFile(fileId: string, actor: OperatorActor): Promise<{ contentType: string; data: Buffer }> {
  assertRole(actor);
  const file = await db.query.sellerVerificationFiles.findFirst({ where: eq(sellerVerificationFiles.id, fileId) });
  if (!file) throw notFound("File");
  await assertOwnShop(file.shopId, actor);
  await audit(actor, AUDIT_ACTIONS.SELLER_DOCUMENT_FILE_VIEWED, "seller_verification", file.verificationId, { fileId, shopId: file.shopId });
  return { contentType: file.contentType, data: decryptBytes(file.dataEncrypted) };
}

/* ---------------------------------------------------------------- 6. board */

export async function operatorLimitedBoardCounts(actor: OperatorActor): Promise<{
  myShops: number;
  pendingShops: number;
  documentsToVerify: number;
  feesPending: number;
  feesFailed: number;
  openOnboardings: number;
}> {
  const shopsRows = await listMyOnboardedShops(actor, { audit: false });
  const docs = await listDocumentsToVerify(actor);
  const open = await listOpenOnboardings(actor);
  return {
    myShops: shopsRows.length,
    pendingShops: shopsRows.filter((s) => s.status === "PENDING_APPROVAL").length,
    documentsToVerify: docs.length,
    feesPending: shopsRows.filter((s) => s.session?.feeStatus === "PENDING").length,
    feesFailed: shopsRows.filter((s) => s.session?.feeStatus === "FAILED" || s.session?.feeStatus === "EXPIRED").length,
    openOnboardings: open.length,
  };
}
