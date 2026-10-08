/**
 * Shop self-registration with auto-approval (Module 3,
 * docs/three-modules-2026-10/MODULE3_SELF_REGISTRATION.md).
 *
 *   1. checkReferralCode       — exists, active, not expired, within its usage
 *                                limit. An invalid code stops everything here:
 *                                no OTP, no payment.
 *   2. createRegistration      — OTP verified, code re-checked under a row lock,
 *                                PENDING_PAYMENT with the fee of the chosen
 *                                tier snapshotted and a slot held on the code.
 *   3. startRegistrationPayment — a gateway order for exactly that fee.
 *   4. processRegistrationPaymentEvent — from the gateway's server webhook only
 *                                (signature already verified by the route):
 *                                amount and currency must equal the fee, then
 *                                approveRegistration does everything in ONE
 *                                transaction: shop APPROVED, owner account,
 *                                receipt, referral redemption, shop wallet,
 *                                distributor commission, audit, event.
 *   Replays and concurrent deliveries approve once: registration row lock +
 *   status check, unique gateway payment id, conditional payment update,
 *   unique shop per registration, unique commission per registration, unique
 *   redemption per shop, event idempotency key.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { parseIndianMobile } from "@/lib/contact";
import { cashfreeApiBase, getEnv, isPaymentGatewayLive } from "@/lib/env";
import { conflict, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { PDF_LINE_WIDTH, textPdf, type PdfLine } from "@/lib/pdf";
import { placeholderEmailFor } from "@/lib/placeholder-email";
import { db, type DbClient } from "@/server/db";
import {
  distributors,
  distributorTypes,
  referralCodes,
  referralCommissions,
  referralRedemptions,
  registrationFeeTiers,
  registrationPayments,
  shopPayments,
  shopRegistrations,
  shops,
  users,
  wallets,
  type ReferralCode,
  type RegistrationPayment,
  type ShopRegistration,
} from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { isTextChannelAvailable, sendText } from "@/server/messaging/sms-whatsapp";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { uniqueSlug } from "@/server/services/catalogue";
import { recordConsent } from "@/server/services/consents";
import { grantRole } from "@/server/services/roles";
import { getRule } from "@/server/services/settings";
import { nextReference } from "@/server/services/shop-payments";
import { getOrCreateShopWallet } from "@/server/services/shop-wallet";
import { verifyRegistrationOtp } from "./otp";

/* ---------------------------------------------------------------- helpers */

export const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const normaliseCode = (raw: string) => raw.trim().toUpperCase();
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

function appOrigin(): string {
  return (getEnv().AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function joinLink(token: string): string {
  return `${appOrigin()}/shop/join/${token}`;
}

export async function assertSelfRegistrationOpen(): Promise<void> {
  if (!(await getRule("selfRegistration")).enabled) {
    throw validationFailed("Shop self-registration is not open yet. Please contact GoKesari or a distributor.");
  }
}

export interface TierView {
  code: string;
  label: string;
  description: string | null;
  amountPaise: number;
}

export async function activeTiers(client: DbClient = db): Promise<TierView[]> {
  return client
    .select({ code: registrationFeeTiers.code, label: registrationFeeTiers.label, description: registrationFeeTiers.description, amountPaise: registrationFeeTiers.amountPaise })
    .from(registrationFeeTiers)
    .where(eq(registrationFeeTiers.isActive, true))
    .orderBy(asc(registrationFeeTiers.sortOrder));
}

/** Shops registered with the code plus unpaid registrations still holding a slot. */
async function codeUsage(codeId: string, client: DbClient): Promise<number> {
  const [{ redeemed }] = await client.select({ redeemed: count() }).from(referralRedemptions).where(eq(referralRedemptions.referralCodeId, codeId));
  const [{ held }] = await client
    .select({ held: count() })
    .from(shopRegistrations)
    .where(and(eq(shopRegistrations.referralCodeId, codeId), eq(shopRegistrations.status, "PENDING_PAYMENT"), gt(shopRegistrations.holdExpiresAt, new Date())));
  return Number(redeemed) + Number(held);
}

export type ReferralProblem = "NOT_FOUND" | "INACTIVE" | "EXPIRED" | "LIMIT_REACHED";

const REFERRAL_MESSAGES: Record<ReferralProblem, string> = {
  NOT_FOUND: "This referral code is not valid. Check it with the person who gave it to you.",
  INACTIVE: "This referral code is not active.",
  EXPIRED: "This referral code has expired.",
  LIMIT_REACHED: "This referral code has already been used the maximum number of times.",
};

/** Why the code cannot be used now, or null when it can. */
async function referralProblem(code: ReferralCode | undefined, client: DbClient, ignoreRegistrationId?: string): Promise<ReferralProblem | null> {
  if (!code) return "NOT_FOUND";
  if (code.status !== "ACTIVE") return code.status === "EXPIRED" ? "EXPIRED" : "INACTIVE";
  if (code.expiresAt && code.expiresAt < today()) return "EXPIRED";
  if (code.maxUses != null) {
    let used = await codeUsage(code.id, client);
    if (ignoreRegistrationId) {
      const [own] = await client
        .select({ id: shopRegistrations.id })
        .from(shopRegistrations)
        .where(and(eq(shopRegistrations.id, ignoreRegistrationId), eq(shopRegistrations.status, "PENDING_PAYMENT"), gt(shopRegistrations.holdExpiresAt, new Date())));
      if (own) used -= 1;
    }
    if (used >= code.maxUses) return "LIMIT_REACHED";
  }
  return null;
}

export type ReferralCheck =
  | { ok: true; code: string; label: string | null; distributor: string | null; tiers: TierView[] }
  | { ok: false; reason: ReferralProblem; message: string };

/** Step 1: is the code usable? Same shape for every outcome; only the message differs. */
export async function checkReferralCode(raw: string): Promise<ReferralCheck> {
  const codeText = normaliseCode(raw);
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(codeText)) return { ok: false, reason: "NOT_FOUND", message: REFERRAL_MESSAGES.NOT_FOUND };
  const [code] = await db.select().from(referralCodes).where(eq(referralCodes.code, codeText));
  const problem = await referralProblem(code, db);
  if (problem) return { ok: false, reason: problem, message: REFERRAL_MESSAGES[problem] };
  let distributor: string | null = null;
  if (code!.distributorId) {
    const [d] = await db.select({ name: distributors.name, status: distributors.status }).from(distributors).where(eq(distributors.id, code!.distributorId));
    distributor = d?.status === "ACTIVE" ? d.name : null;
  }
  return { ok: true, code: code!.code, label: code!.label, distributor, tiers: await activeTiers() };
}

/* ------------------------------------------------------------ registration */

export const createRegistrationSchema = z.object({
  shopName: z.string().trim().min(2, "Enter the shop's name.").max(100),
  mobile: z.string().trim().min(10).max(16),
  referralCode: z.string().trim().min(3).max(32),
  tierCode: z.string().trim().min(2).max(32),
  otp: z.string().trim().min(4).max(8),
  acceptTerms: z.literal(true, { message: "Accept the seller terms to continue." }),
});

export function parseMobileOrThrow(raw: string): { e164: string; national: string } {
  const parsed = parseIndianMobile(raw);
  if (!parsed.ok) throw validationFailed(parsed.error);
  return parsed;
}

/** Step 2: OTP checked, code re-checked under a lock, registration saved as PENDING_PAYMENT. Returns the private token (shown once). */
export async function createRegistration(
  input: z.infer<typeof createRegistrationSchema>,
  ip: string | null,
): Promise<{ token: string; registration: ShopRegistration }> {
  await assertSelfRegistrationOpen();
  const rules = await getRule("selfRegistration");
  const mobile = parseMobileOrThrow(input.mobile);
  // The code first: an invalid code stops here, before the OTP is used up.
  const pre = await checkReferralCode(input.referralCode);
  if (!pre.ok) throw validationFailed(pre.message, { reason: pre.reason });
  const verifiedAt = await verifyRegistrationOtp(mobile.e164, input.otp);

  const token = randomBytes(32).toString("base64url");
  const registration = await db.transaction(async (tx) => {
    const [code] = await tx.select().from(referralCodes).where(eq(referralCodes.code, normaliseCode(input.referralCode))).for("update");
    const problem = await referralProblem(code, tx);
    if (problem) throw validationFailed(REFERRAL_MESSAGES[problem], { reason: problem });
    const [tier] = await tx
      .select()
      .from(registrationFeeTiers)
      .where(and(eq(registrationFeeTiers.code, input.tierCode.toUpperCase()), eq(registrationFeeTiers.isActive, true)));
    if (!tier || tier.amountPaise <= 0) throw validationFailed("Choose one of the fee plans shown.");
    const [{ pending }] = await tx
      .select({ pending: count() })
      .from(shopRegistrations)
      .where(and(eq(shopRegistrations.mobileE164, mobile.e164), eq(shopRegistrations.status, "PENDING_PAYMENT"), gt(shopRegistrations.holdExpiresAt, new Date())));
    if (Number(pending) >= rules.maxPendingPerMobile) {
      throw conflict("This mobile number already has unpaid registrations. Pay or wait for them to lapse — the payment link was sent by SMS.");
    }
    let distributorId: string | null = null;
    if (code!.distributorId) {
      const [d] = await tx.select({ id: distributors.id, status: distributors.status }).from(distributors).where(eq(distributors.id, code!.distributorId));
      distributorId = d?.status === "ACTIVE" ? d.id : null;
    }
    const [row] = await tx
      .insert(shopRegistrations)
      .values({
        tokenHash: hashToken(token),
        shopName: input.shopName,
        mobileE164: mobile.e164,
        mobileVerifiedAt: verifiedAt,
        referralCodeId: code!.id,
        distributorId,
        feeTierId: tier.id,
        feePaise: tier.amountPaise,
        holdExpiresAt: new Date(Date.now() + rules.holdHours * 3600_000),
        ipAddress: ip,
        lastLinkSentAt: new Date(),
      })
      .returning();
    await recordAudit(
      {
        action: AUDIT_ACTIONS.SHOP_SELF_REGISTRATION_STARTED,
        entityType: "shop_registration",
        entityId: row.id,
        newValue: { shopName: row.shopName, mobile: `******${mobile.national.slice(-4)}`, referralCode: code!.code, tier: tier.code, feePaise: tier.amountPaise },
        ipAddress: ip,
      },
      tx,
    );
    return row;
  });
  await sendText(
    "SMS",
    mobile.e164,
    `GoKesari: to finish registering ${registration.shopName}, pay ${formatPaise(registration.feePaise)} here: ${joinLink(token)}`,
    "registration-link",
  ).catch((e) => console.error("[registration] link SMS failed", e));
  return { token, registration };
}

export async function registrationByToken(token: string): Promise<ShopRegistration> {
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(token)) throw notFound("Registration");
  const [row] = await db.select().from(shopRegistrations).where(eq(shopRegistrations.tokenHash, hashToken(token)));
  if (!row) throw notFound("Registration");
  return row;
}

/** What the applicant's page shows. */
export async function registrationStatus(token: string) {
  const reg = await registrationByToken(token);
  const [tier] = await db.select().from(registrationFeeTiers).where(eq(registrationFeeTiers.id, reg.feeTierId));
  const [code] = await db.select({ code: referralCodes.code }).from(referralCodes).where(eq(referralCodes.id, reg.referralCodeId));
  const [lastPayment] = await db
    .select()
    .from(registrationPayments)
    .where(eq(registrationPayments.shopRegistrationId, reg.id))
    .orderBy(desc(registrationPayments.createdAt))
    .limit(1);
  let shop: { id: string; registrationNumber: string; name: string } | null = null;
  let receipt: string | null = null;
  if (reg.shopId) {
    const [s] = await db.select({ id: shops.id, registrationNumber: shops.registrationNumber, name: shops.name }).from(shops).where(eq(shops.id, reg.shopId));
    shop = s ?? null;
    const [p] = await db.select({ reference: shopPayments.reference }).from(shopPayments).where(and(eq(shopPayments.shopId, reg.shopId), eq(shopPayments.paymentType, "REGISTRATION_FEE")));
    receipt = p?.reference ?? null;
  }
  return {
    status: reg.status,
    shopName: reg.shopName,
    mobile: `+91 ******${reg.mobileE164.slice(-4)}`,
    feePaise: reg.feePaise,
    tier: tier ? { code: tier.code, label: tier.label } : null,
    referralCode: code?.code ?? null,
    holdExpiresAt: reg.holdExpiresAt,
    lastPayment: lastPayment ? { status: lastPayment.status, failureReason: lastPayment.failureReason, createdAt: lastPayment.createdAt } : null,
    shop,
    receipt,
    gateway: isPaymentGatewayLive() ? ("CASHFREE" as const) : ("MOCK" as const),
  };
}

/* ----------------------------------------------------------------- payment */

export interface StartedPayment {
  gateway: "CASHFREE" | "MOCK";
  orderId: string;
  paymentSessionId: string | null;
  amountPaise: number;
  /** The Cashfree environment the order was created in (the checkout widget must match). */
  cashfreeMode: "sandbox" | "production";
}

/** Step 3: a gateway order for exactly the snapshotted fee. Paying after the hold lapsed is allowed while the code still has room. */
export async function startRegistrationPayment(token: string): Promise<StartedPayment> {
  const reg = await registrationByToken(token);
  if (reg.status === "APPROVED") throw conflict("This registration is already paid and approved.");
  if (reg.status !== "PENDING_PAYMENT") throw conflict("This registration was cancelled. Start a new one.");
  if (reg.holdExpiresAt.getTime() < Date.now()) {
    const rules = await getRule("selfRegistration");
    await db.transaction(async (tx) => {
      const [code] = await tx.select().from(referralCodes).where(eq(referralCodes.id, reg.referralCodeId)).for("update");
      const problem = await referralProblem(code, tx, reg.id);
      if (problem) throw validationFailed(`${REFERRAL_MESSAGES[problem]} This registration cannot be paid now.`, { reason: problem });
      await tx
        .update(shopRegistrations)
        .set({ holdExpiresAt: new Date(Date.now() + rules.holdHours * 3600_000), updatedAt: new Date() })
        .where(eq(shopRegistrations.id, reg.id));
    });
  }
  if (!isPaymentGatewayLive()) {
    const orderId = `mockreg_${randomUUID()}`;
    await db.insert(registrationPayments).values({ shopRegistrationId: reg.id, gateway: "MOCK", gatewayOrderId: orderId, amountPaise: reg.feePaise });
    return { gateway: "MOCK", orderId, paymentSessionId: null, amountPaise: reg.feePaise, cashfreeMode: getEnv().CASHFREE_ENV };
  }
  const orderId = `reg_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const env = getEnv();
  const response = await fetch(`${cashfreeApiBase()}/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-version": "2023-08-01",
      "x-client-id": env.CASHFREE_APP_ID!,
      "x-client-secret": env.CASHFREE_SECRET_KEY!,
    },
    body: JSON.stringify({
      order_id: orderId,
      order_amount: reg.feePaise / 100,
      order_currency: "INR",
      customer_details: { customer_id: `reg_${reg.id.replace(/-/g, "")}`.slice(0, 50), customer_phone: reg.mobileE164.slice(3) },
      order_meta: {
        return_url: `${joinLink(token)}?order_id={order_id}`,
        notify_url: `${appOrigin()}/api/webhooks/cashfree`,
      },
      order_note: `GoKesari shop registration: ${reg.shopName}`.slice(0, 200),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    console.error("[registration] Cashfree order failed", response.status, await response.text());
    throw new Error("Could not start the payment. Please try again.");
  }
  const order = (await response.json()) as { order_id: string; payment_session_id: string };
  await db.insert(registrationPayments).values({
    shopRegistrationId: reg.id,
    gateway: "CASHFREE",
    gatewayOrderId: order.order_id,
    paymentSessionId: order.payment_session_id,
    amountPaise: reg.feePaise,
  });
  return { gateway: "CASHFREE", orderId: order.order_id, paymentSessionId: order.payment_session_id, amountPaise: reg.feePaise, cashfreeMode: env.CASHFREE_ENV };
}

export const isRegistrationOrder = (orderId: string) => orderId.startsWith("reg_") || orderId.startsWith("mockreg_");

export interface RegistrationPaymentEvent {
  orderId: string;
  paymentId: string | null;
  /** SUCCESS, FAILED, USER_DROPPED, … as the gateway says it. */
  paymentStatus: string;
  /** Rupees, as the gateway sends them. */
  orderAmount: number | null;
  paymentAmount: number | null;
  currency: string | null;
  raw: Record<string, unknown>;
}

export type PaymentOutcome =
  | { outcome: "APPROVED"; shopId: string; ownerId: string }
  | { outcome: "ALREADY_APPROVED"; shopId: string | null }
  | { outcome: "FAILED" | "MISMATCH" | "IGNORED"; reason: string };

const toPaise = (rupees: number | null) => (rupees == null || !Number.isFinite(rupees) ? null : Math.round(rupees * 100));

/** Step 4: from the gateway's verified webhook only. */
export async function processRegistrationPaymentEvent(event: RegistrationPaymentEvent): Promise<PaymentOutcome> {
  const [payment] = await db.select().from(registrationPayments).where(eq(registrationPayments.gatewayOrderId, event.orderId));
  if (!payment) return { outcome: "IGNORED", reason: "Not a registration order of ours." };
  const status = event.paymentStatus.toUpperCase();
  if (status !== "SUCCESS") {
    if (payment.status === "CREATED") {
      await db
        .update(registrationPayments)
        .set({ status: "FAILED", failureReason: status.toLowerCase().replace(/_/g, " "), webhookPayload: event.raw, updatedAt: new Date() })
        .where(and(eq(registrationPayments.id, payment.id), eq(registrationPayments.status, "CREATED")));
      const [reg] = await db.select().from(shopRegistrations).where(eq(shopRegistrations.id, payment.shopRegistrationId));
      await recordAudit({ action: AUDIT_ACTIONS.SHOP_REGISTRATION_PAYMENT_FAILED, entityType: "shop_registration", entityId: reg.id, newValue: { orderId: event.orderId, status } });
      if (reg.status === "PENDING_PAYMENT") {
        await sendText("SMS", reg.mobileE164, `GoKesari: the payment for ${reg.shopName} did not go through. You can try again with the link sent earlier, or ask your distributor to resend it.`, "registration-retry").catch(() => undefined);
      }
    }
    return { outcome: "FAILED", reason: status };
  }

  // Money must be exactly the fee, in rupees, for this order.
  const [reg] = await db.select().from(shopRegistrations).where(eq(shopRegistrations.id, payment.shopRegistrationId));
  const orderPaise = toPaise(event.orderAmount);
  const paidPaise = toPaise(event.paymentAmount);
  const currencyOk = (event.currency ?? "INR").toUpperCase() === "INR";
  if (!currencyOk || orderPaise !== payment.amountPaise || paidPaise !== payment.amountPaise || payment.amountPaise !== reg.feePaise) {
    const [flagged] = await db
      .update(registrationPayments)
      .set({ status: "MISMATCH", gatewayPaymentId: event.paymentId, failureReason: `paid ${paidPaise ?? "?"} / order ${orderPaise ?? "?"} ${event.currency ?? ""}, fee ${reg.feePaise}`, webhookPayload: event.raw, updatedAt: new Date() })
      .where(and(eq(registrationPayments.id, payment.id), inArray(registrationPayments.status, ["CREATED", "FAILED"])))
      .returning();
    if (flagged) {
      await recordAudit({ action: AUDIT_ACTIONS.SHOP_REGISTRATION_PAYMENT_MISMATCH, entityType: "shop_registration", entityId: reg.id, newValue: { orderId: event.orderId, paidPaise, orderPaise, currency: event.currency, feePaise: reg.feePaise } });
      await emitEvent({
        type: "registration.payment_mismatch",
        subjectId: reg.id,
        payload: { shopName: reg.shopName, paidPaise: paidPaise ?? 0, feePaise: reg.feePaise, orderId: event.orderId, problem: "The amount paid does not match the fee; the shop was not approved." },
        idempotencyKey: `registration-mismatch:${payment.id}`,
      }).catch((e) => console.error("[registration] mismatch notice failed", e));
    }
    return { outcome: "MISMATCH", reason: "The amount paid is not the registration fee." };
  }
  return approveRegistration(payment, event);
}

function commissionAmount(type: "FLAT" | "PERCENT", value: number, basePaise: number): number {
  return type === "FLAT" ? value : Math.round((basePaise * value) / 10_000);
}

/** Everything in one transaction. Idempotent: replays and concurrent deliveries approve once. */
export async function approveRegistration(payment: RegistrationPayment, event: RegistrationPaymentEvent): Promise<PaymentOutcome> {
  const result = await db.transaction(async (tx) => {
    const [reg] = await tx.select().from(shopRegistrations).where(eq(shopRegistrations.id, payment.shopRegistrationId)).for("update");
    if (reg.status !== "PENDING_PAYMENT") {
      // Money taken for a registration that cannot be approved again — a second
      // payment after approval, or one after support cancelled it — is money to
      // give back: recorded as refund due and support is told. A replay of the
      // payment that approved it changes nothing (that row is already SUCCESS).
      const problem = reg.status === "APPROVED" ? "Paid again after approval — refund due" : `Paid after the registration was ${reg.status.toLowerCase()} — refund due`;
      const [flagged] = await tx
        .update(registrationPayments)
        .set({ status: "SUCCESS", gatewayPaymentId: event.paymentId, verifiedAt: new Date(), failureReason: problem, webhookPayload: event.raw, updatedAt: new Date() })
        .where(and(eq(registrationPayments.id, payment.id), inArray(registrationPayments.status, ["CREATED", "FAILED"])))
        .returning();
      if (flagged) {
        await recordAudit(
          { action: AUDIT_ACTIONS.SHOP_REGISTRATION_PAYMENT_MISMATCH, entityType: "shop_registration", entityId: reg.id, newValue: { orderId: event.orderId, paymentId: event.paymentId, problem } },
          tx,
        );
        await emitEvent(
          {
            type: "registration.payment_mismatch",
            subjectId: reg.id,
            payload: { shopName: reg.shopName, paidPaise: payment.amountPaise, feePaise: reg.feePaise, orderId: event.orderId, problem: `${problem}.` },
            idempotencyKey: `registration-refund:${payment.id}`,
          },
          tx,
        );
      }
      if (reg.status === "APPROVED") return { outcome: "ALREADY_APPROVED" as const, shopId: reg.shopId };
      return { outcome: "IGNORED" as const, reason: `Registration is ${reg.status.toLowerCase()}; the payment is marked for a refund.` };
    }

    const now = new Date();
    const [paid] = await tx
      .update(registrationPayments)
      .set({ status: "SUCCESS", gatewayPaymentId: event.paymentId, verifiedAt: now, failureReason: null, webhookPayload: event.raw, updatedAt: now })
      .where(and(eq(registrationPayments.id, payment.id), inArray(registrationPayments.status, ["CREATED", "FAILED"])))
      .returning();
    if (!paid) return { outcome: "ALREADY_APPROVED" as const, shopId: reg.shopId };

    // The owner's account: the mobile's existing account, or a new one (verified mobile, no email yet).
    const [existing] = await tx.select().from(users).where(and(eq(users.phoneE164, reg.mobileE164), isNull(users.deletedAt)));
    let owner = existing;
    let newAccount = false;
    if (!owner) {
      [owner] = await tx
        .insert(users)
        .values({
          email: placeholderEmailFor(reg.mobileE164),
          emailPlaceholder: true,
          phoneE164: reg.mobileE164,
          phone: reg.mobileE164.slice(3),
          phoneVerifiedAt: reg.mobileVerifiedAt,
          role: "SHOP_OWNER",
        })
        .returning();
      await tx.insert(wallets).values({ userId: owner.id }).onConflictDoNothing();
      newAccount = true;
    } else if (!owner.phoneVerifiedAt) {
      await tx.update(users).set({ phoneVerifiedAt: reg.mobileVerifiedAt, updatedAt: now }).where(eq(users.id, owner.id));
    }
    await grantRole(owner.id, "SHOP_OWNER", { source: "SHOP_REGISTRATION", activateIfCustomer: true }, tx);

    const rules = await getRule("selfRegistration");
    const [code] = await tx.select().from(referralCodes).where(eq(referralCodes.id, reg.referralCodeId));
    const [shop] = await tx
      .insert(shops)
      .values({
        ownerId: owner.id,
        name: reg.shopName,
        slug: uniqueSlug(reg.shopName),
        // Completed by the owner after sign-in (profile setup); until then the shop is found by name, not by area.
        ownerName: "",
        phone: reg.mobileE164.slice(3),
        addressLine1: "",
        city: "",
        pincode: "",
        shopType: "GENERAL_TRADING",
        status: "APPROVED",
        approvedAt: now,
        statusActorId: owner.id,
        classification: rules.classification,
        registrationDate: today(),
        registrationFeePaise: reg.feePaise,
        feePaymentStatus: "PAID",
        amountPaidPaise: reg.feePaise,
        referralCodeId: reg.referralCodeId,
        onboardingChannel: "SELF_SERVICE",
        shopRegistrationId: reg.id,
        registrationTierId: reg.feeTierId,
        autoApprovedAt: now,
      })
      .returning();

    const reference = await nextReference(tx);
    await tx.insert(shopPayments).values({
      reference,
      shopId: shop.id,
      ownerId: owner.id,
      paymentType: "REGISTRATION_FEE",
      amountPaise: reg.feePaise,
      method: "CASHFREE",
      transactionId: event.paymentId ?? payment.gatewayOrderId,
      feeSnapshotPaise: reg.feePaise,
      paidAt: now,
      note: `Self-registration fee, order ${payment.gatewayOrderId}${payment.gateway === "MOCK" ? " (test payment)" : ""}`,
      recordedBy: owner.id,
    });
    await tx.insert(referralRedemptions).values({ referralCodeId: reg.referralCodeId, shopId: shop.id, registrationFeePaise: reg.feePaise, redeemedBy: owner.id });
    await getOrCreateShopWallet(shop.id, tx);

    // The distributor's commission: its own rate, else its type's default. Recorded only.
    let commission: { amountPaise: number; distributorId: string } | null = null;
    if (reg.distributorId) {
      const [d] = await tx
        .select({ distributor: distributors, type: distributorTypes })
        .from(distributors)
        .innerJoin(distributorTypes, eq(distributorTypes.id, distributors.distributorTypeId))
        .where(eq(distributors.id, reg.distributorId));
      if (d) {
        const type = d.distributor.commissionType ?? d.type.commissionType;
        const value = d.distributor.commissionValue ?? d.type.commissionValue;
        const amountPaise = commissionAmount(type, value, reg.feePaise);
        await tx.insert(referralCommissions).values({
          shopRegistrationId: reg.id,
          shopId: shop.id,
          referralCodeId: reg.referralCodeId,
          distributorId: d.distributor.id,
          referrerUserId: code?.referrerUserId ?? null,
          basePaise: reg.feePaise,
          commissionType: type,
          commissionValue: value,
          amountPaise,
        });
        commission = { amountPaise, distributorId: d.distributor.id };
      }
    }

    await tx
      .update(shopRegistrations)
      .set({ status: "APPROVED", approvedAt: now, ownerUserId: owner.id, shopId: shop.id, updatedAt: now })
      .where(eq(shopRegistrations.id, reg.id));
    await recordAudit(
      {
        actorId: owner.id,
        action: AUDIT_ACTIONS.SHOP_SELF_REGISTERED,
        entityType: "shop",
        entityId: shop.id,
        newValue: {
          registrationId: reg.id,
          registrationNumber: shop.registrationNumber,
          referralCode: code?.code,
          feePaise: reg.feePaise,
          receipt: reference,
          gatewayOrderId: payment.gatewayOrderId,
          gatewayPaymentId: event.paymentId,
          newAccount,
          commission,
        },
      },
      tx,
    );
    await emitEvent(
      {
        type: "shop.self_registered",
        subjectId: shop.id,
        actor: { id: owner.id, role: "SHOP_OWNER" },
        payload: {
          shopId: shop.id,
          shopName: shop.name,
          ownerId: owner.id,
          registrationNumber: shop.registrationNumber,
          mobile: `+91 ${reg.mobileE164.slice(3)}`,
          receiptNumber: reference,
          referralCode: code?.code ?? "",
          feePaise: reg.feePaise,
        },
        idempotencyKey: `shop-self-registered:${reg.id}`,
      },
      tx,
    );
    return { outcome: "APPROVED" as const, shopId: shop.id, ownerId: owner.id, newAccount };
  });
  if (result.outcome === "APPROVED" && result.newAccount) {
    // Seller terms were accepted on the registration form.
    await recordConsent(result.ownerId, "TERMS_AND_PRIVACY", {}).catch((e) => console.error("[registration] consent record failed", e));
  }
  if (result.outcome === "APPROVED") return { outcome: "APPROVED", shopId: result.shopId, ownerId: result.ownerId };
  return result;
}

/* ----------------------------------------------------------------- receipt */

const when = (d: Date) => d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });

export async function registrationReceiptPdf(token: string): Promise<{ fileName: string; body: Buffer }> {
  const reg = await registrationByToken(token);
  if (reg.status !== "APPROVED" || !reg.shopId) throw notFound("Receipt");
  const [shop] = await db.select().from(shops).where(eq(shops.id, reg.shopId));
  const [pay] = await db.select().from(shopPayments).where(and(eq(shopPayments.shopId, reg.shopId), eq(shopPayments.paymentType, "REGISTRATION_FEE")));
  const [tier] = await db.select().from(registrationFeeTiers).where(eq(registrationFeeTiers.id, reg.feeTierId));
  const [code] = await db.select({ code: referralCodes.code }).from(referralCodes).where(eq(referralCodes.id, reg.referralCodeId));
  const money = (p: number) => formatPaise(p).replace("₹", "Rs. ");
  const W = PDF_LINE_WIDTH;
  const lines: PdfLine[] = [];
  const add = (text = "", bold = false) => lines.push({ text, bold });
  const pair = (l: string, r: string) => add(l + r.padStart(Math.max(1, W - l.length)));
  add("PAYMENT RECEIPT", true);
  pair(`Receipt no: ${pay?.reference ?? "-"}`, `Date: ${when(pay?.paidAt ?? reg.approvedAt ?? new Date())}`);
  add("-".repeat(W));
  add("Received from", true);
  add(shop.name);
  add(`GoKesari shop no: ${shop.registrationNumber}`);
  add(`Mobile: +91 ${reg.mobileE164.slice(3)}`);
  add();
  pair(`Shop registration fee — ${tier?.label ?? ""} plan`, money(reg.feePaise));
  add(`Referral code: ${code?.code ?? "-"}`);
  add(`Paid online (Cashfree), payment id: ${pay?.transactionId ?? "-"}`);
  add("-".repeat(W));
  pair("Total received", money(reg.feePaise));
  add();
  add("This is a payment receipt, not a tax invoice.");
  add("Issued by GoKesari. Computer-generated; no signature required.");
  return { fileName: `${pay?.reference ?? "receipt"}.pdf`, body: textPdf(lines, { title: `Receipt ${pay?.reference ?? ""}` }) };
}

/* ------------------------------------------------------------- operations */

/** Support: send the private payment link again (a new link; the old one stops working). */
export async function resendRegistrationLink(registrationId: string, actor: { id: string; role: string }): Promise<void> {
  const [reg] = await db.select().from(shopRegistrations).where(eq(shopRegistrations.id, registrationId));
  if (!reg) throw notFound("Registration");
  if (reg.status !== "PENDING_PAYMENT") throw conflict("Only an unpaid registration has a payment link.");
  if (!isTextChannelAvailable("SMS")) throw conflict("SMS is not set up on this server.");
  const token = randomBytes(32).toString("base64url");
  await db.update(shopRegistrations).set({ tokenHash: hashToken(token), lastLinkSentAt: new Date(), updatedAt: new Date() }).where(eq(shopRegistrations.id, reg.id));
  await sendText("SMS", reg.mobileE164, `GoKesari: to finish registering ${reg.shopName}, pay ${formatPaise(reg.feePaise)} here: ${joinLink(token)}`, "registration-link");
  await recordAudit({ actorId: actor.id, action: AUDIT_ACTIONS.SHOP_REGISTRATION_LINK_RESENT, entityType: "shop_registration", entityId: reg.id });
}

export async function cancelRegistration(registrationId: string, actor: { id: string }): Promise<void> {
  const [row] = await db
    .update(shopRegistrations)
    .set({ status: "CANCELLED", cancelledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(shopRegistrations.id, registrationId), eq(shopRegistrations.status, "PENDING_PAYMENT")))
    .returning();
  if (!row) throw conflict("Only an unpaid registration can be cancelled.");
  await recordAudit({ actorId: actor.id, action: AUDIT_ACTIONS.SHOP_SELF_REGISTRATION_STARTED, entityType: "shop_registration", entityId: row.id, newValue: { cancelled: true } });
}

/** Number of registrations by status (admin overview). */
export async function registrationCounts() {
  const rows = await db.select({ status: shopRegistrations.status, n: count() }).from(shopRegistrations).groupBy(shopRegistrations.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

