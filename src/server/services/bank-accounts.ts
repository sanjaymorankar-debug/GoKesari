/**
 * Bank accounts and ₹1 verification (docs/four-features-2026-10, feature 3).
 *
 * Shop owners (for payouts) and customers (for refunds to a bank) add a bank
 * account — holder name, account number and IFSC — or a UPI ID, and verify it
 * with a ₹1 payment through the existing gateway (Cashfree PG), refunded
 * straight away. Cashfree PG has no penny-drop (crediting ₹1 to an account
 * needs its separate Payouts / Verification product and keys), so the
 * integrated option is "₹1 debit from the user, refunded" — every method the
 * gateway offers: UPI, debit card, credit card and net banking.
 *
 * Proof, in order of strength: the gateway reports the payer's name (matched
 * against the holder name), or the paying UPI ID / account (matched against
 * the details given); otherwise — a card payment — the ₹1 shows the user
 * controls a working payment instrument and the declared name is recorded
 * (match method PAYMENT_ONLY), visible to finance.
 *
 * Nothing card-related is ever sent to this server: the checkout widget is
 * Cashfree's. Account numbers and UPI IDs are encrypted at rest; screens show
 * the last 4 digits only. A payment is confirmed only by asking Cashfree
 * server-to-server, never from what the browser says.
 *
 * Without gateway keys (local, CI, or a test site without sandbox keys) a
 * clearly labelled simulator takes the gateway's place — never on the
 * production site (isProductionSite).
 */
import crypto from "node:crypto";

import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";

import {
  checkAccountNumber,
  checkHolderName,
  checkIfsc,
  checkUpiId,
  maskAccountNumber,
  maskUpiId,
  type BankMethod,
  type VerificationMethod,
} from "@/lib/bank-accounts";
import { cashfreeApiBase, getEnv, isPaymentGatewayLive } from "@/lib/env";
import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { nameMatchScore } from "@/lib/kyc/name-match";
import { decryptSecret, encryptSecret } from "@/lib/pan-crypto";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import {
  bankAccounts,
  bankVerificationAttempts,
  orders,
  shopSettlements,
  shops,
  users,
  type BankAccount,
  type BankVerificationAttempt,
  type UserRole,
} from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

/* ================================================================ site */

/** gokesari.com (or www.) — where a simulated gateway must never run. */
export function isProductionSite(): boolean {
  const env = getEnv();
  let host = "";
  try {
    host = env.AUTH_URL ? new URL(env.AUTH_URL).hostname.toLowerCase() : "";
  } catch {
    host = "";
  }
  const prod = env.KYC_PRODUCTION_HOST.toLowerCase();
  return host === prod || host === `www.${prod}`;
}

export type GatewayMode = "CASHFREE" | "SIMULATOR" | "UNAVAILABLE";

export function verificationGatewayMode(): GatewayMode {
  if (isPaymentGatewayLive()) return "CASHFREE";
  return isProductionSite() ? "UNAVAILABLE" : "SIMULATOR";
}

/* ============================================================= saving */

export interface SaveBankAccountInput {
  method: BankMethod;
  accountHolderName: string;
  accountNumber?: string | null;
  confirmAccountNumber?: string | null;
  ifsc?: string | null;
  upiId?: string | null;
}

export interface BankAccountView {
  id: string;
  holderType: "CUSTOMER" | "SHOP";
  shopId: string | null;
  method: BankMethod;
  accountHolderName: string;
  accountNumberMasked: string | null;
  ifsc: string | null;
  upiIdMasked: string | null;
  status: BankAccount["status"];
  matchedAccountHolderName: string | null;
  matchMethod: string | null;
  verifiedAt: string | null;
  verificationPaymentMethod: string | null;
  gatewayReference: string | null;
  failureReason: string | null;
  lastAttempt: { status: string; refundStatus: string; paymentMethod: string | null; createdAt: string } | null;
}

function label(account: Pick<BankAccount, "method" | "accountNumberLast4" | "ifsc" | "upiIdMasked">): string {
  return account.method === "UPI" ? `UPI ID ${account.upiIdMasked}` : `Account ${maskAccountNumber(account.accountNumberLast4)} (${account.ifsc})`;
}

async function toView(account: BankAccount): Promise<BankAccountView> {
  const [attempt] = await db
    .select()
    .from(bankVerificationAttempts)
    .where(eq(bankVerificationAttempts.bankAccountId, account.id))
    .orderBy(desc(bankVerificationAttempts.createdAt))
    .limit(1);
  return {
    id: account.id,
    holderType: account.holderType,
    shopId: account.shopId,
    method: account.method,
    accountHolderName: account.accountHolderName,
    accountNumberMasked: maskAccountNumber(account.accountNumberLast4),
    ifsc: account.ifsc,
    upiIdMasked: account.upiIdMasked,
    status: account.status,
    matchedAccountHolderName: account.matchedAccountHolderName,
    matchMethod: account.matchMethod,
    verifiedAt: account.verifiedAt?.toISOString() ?? null,
    verificationPaymentMethod: account.verificationPaymentMethod,
    gatewayReference: account.gatewayReference,
    failureReason: account.failureReason,
    lastAttempt: attempt
      ? { status: attempt.status, refundStatus: attempt.refundStatus, paymentMethod: attempt.paymentMethod, createdAt: attempt.createdAt.toISOString() }
      : null,
  };
}

async function assertOwnerOf(shopId: string, actor: Actor): Promise<{ id: string; name: string; ownerId: string }> {
  const [shop] = await db.select({ id: shops.id, name: shops.name, ownerId: shops.ownerId }).from(shops).where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  // Only the owner adds where the shop's money goes; staff can look, not change.
  if (shop.ownerId !== actor.id) throw forbidden("Only the shop's owner can change its bank account.");
  return shop;
}

/** The current account (customer: shopId null). */
export async function currentBankAccount(userId: string, shopId: string | null, client: DbClient = db): Promise<BankAccount | null> {
  const [row] = await client
    .select()
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.isCurrent, true),
        shopId ? eq(bankAccounts.shopId, shopId) : and(eq(bankAccounts.userId, userId), isNull(bankAccounts.shopId)),
      ),
    );
  return row ?? null;
}

export async function getBankAccountView(userId: string, shopId: string | null): Promise<BankAccountView | null> {
  const row = await currentBankAccount(userId, shopId);
  return row ? toView(row) : null;
}

/**
 * Adds the account, or replaces it when the details change (the old one stops
 * being current, so the new details need their own verification). Saving the
 * same details again changes nothing.
 */
export async function saveBankAccount(
  owner: { userId: string; shopId: string | null },
  input: SaveBankAccountInput,
  actor: Actor,
): Promise<BankAccountView> {
  if (owner.shopId) await assertOwnerOf(owner.shopId, actor);
  else if (owner.userId !== actor.id) throw forbidden("You can only change your own bank account.");

  const fields: Record<string, string> = {};
  const holder = checkHolderName(input.accountHolderName);
  if (!holder.ok) fields.accountHolderName = holder.error;
  let accountNumber: string | null = null;
  let ifsc: string | null = null;
  let upi: string | null = null;
  if (input.method === "BANK_ACCOUNT") {
    const number = checkAccountNumber(input.accountNumber ?? "");
    if (!number.ok) fields.accountNumber = number.error;
    else accountNumber = number.value;
    if (input.confirmAccountNumber != null && number.ok && checkAccountNumber(input.confirmAccountNumber).ok !== true) {
      fields.confirmAccountNumber = "Re-enter the account number.";
    } else if (input.confirmAccountNumber != null && number.ok && input.confirmAccountNumber.replace(/[\s-]/g, "") !== number.value) {
      fields.confirmAccountNumber = "The two account numbers do not match.";
    }
    const code = checkIfsc(input.ifsc ?? "");
    if (!code.ok) fields.ifsc = code.error;
    else ifsc = code.value;
  } else {
    const id = checkUpiId(input.upiId ?? "");
    if (!id.ok) fields.upiId = id.error;
    else upi = id.value;
  }
  if (Object.keys(fields).length > 0) throw validationFailed(Object.values(fields)[0], { fields });

  const current = await currentBankAccount(owner.userId, owner.shopId);
  if (current) {
    const same =
      current.method === input.method &&
      current.accountHolderName === (holder.ok ? holder.value : "") &&
      (input.method === "UPI"
        ? current.upiIdEncrypted != null && decryptSecret(current.upiIdEncrypted) === upi
        : current.accountNumberEncrypted != null && decryptSecret(current.accountNumberEncrypted) === accountNumber && current.ifsc === ifsc);
    if (same) return toView(current);
  }

  const row = await db.transaction(async (tx) => {
    if (current) {
      await tx.update(bankAccounts).set({ isCurrent: false, supersededAt: new Date(), updatedAt: new Date() }).where(eq(bankAccounts.id, current.id));
    }
    const [created] = await tx
      .insert(bankAccounts)
      .values({
        userId: owner.userId,
        shopId: owner.shopId,
        holderType: owner.shopId ? "SHOP" : "CUSTOMER",
        method: input.method,
        accountHolderName: holder.ok ? holder.value : "",
        accountNumberEncrypted: accountNumber ? encryptSecret(accountNumber) : null,
        accountNumberLast4: accountNumber ? accountNumber.slice(-4) : null,
        ifsc,
        upiIdEncrypted: upi ? encryptSecret(upi) : null,
        upiIdMasked: upi ? maskUpiId(upi) : null,
      })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.BANK_ACCOUNT_SAVED,
        entityType: "bank_account",
        entityId: created.id,
        previousValue: current ? { id: current.id, status: current.status, account: label(current) } : null,
        newValue: { shopId: owner.shopId, method: created.method, account: label(created) },
      },
      tx,
    );
    return created;
  });
  return toView(row);
}

/* ======================================================= verification */

export interface StartVerificationResult {
  attemptId: string;
  gatewayOrderId: string;
  amountPaise: number;
  mode: "CASHFREE" | "SIMULATOR";
  /** Cashfree only: for the checkout widget. */
  paymentSessionId: string | null;
  cashfreeMode: "sandbox" | "production";
}

async function loadOwnAccount(accountId: string, actor: Actor): Promise<BankAccount> {
  const [account] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, accountId));
  // Someone else's account looks exactly like a missing one.
  if (!account || account.userId !== actor.id) throw notFound("Bank account");
  return account;
}

const CASHFREE_API_VERSION = "2023-08-01";
function cashfreeHeaders(): Record<string, string> {
  const env = getEnv();
  return {
    "Content-Type": "application/json",
    "x-api-version": CASHFREE_API_VERSION,
    "x-client-id": env.CASHFREE_APP_ID!,
    "x-client-secret": env.CASHFREE_SECRET_KEY!,
  };
}

/** Starts a ₹1 verification payment (UPI, debit card, credit card or net banking). */
export async function startBankVerification(accountId: string, actor: Actor): Promise<StartVerificationResult> {
  const account = await loadOwnAccount(accountId, actor);
  if (!account.isCurrent) throw conflict("These details were replaced — verify the current account.");
  if (account.status === "VERIFIED") throw conflict("This account is already verified.");
  const rules = await getRule("bankAccounts");
  const mode = verificationGatewayMode();
  if (mode === "UNAVAILABLE") throw conflict("Payments are not set up on this site yet. Please try again later.");

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bankVerificationAttempts)
    .where(and(eq(bankVerificationAttempts.userId, actor.id), gte(bankVerificationAttempts.createdAt, new Date(Date.now() - 86_400_000))));
  if (n >= rules.maxAttemptsPerDay) {
    throw new AppError("RATE_LIMITED", `You can try verifying ${rules.maxAttemptsPerDay} times a day. Please try again tomorrow.`);
  }

  const gatewayOrderId = `bankverify_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  let paymentSessionId: string | null = null;
  if (mode === "CASHFREE") {
    const [user] = await db.select().from(users).where(eq(users.id, actor.id));
    const response = await fetch(`${cashfreeApiBase()}/orders`, {
      method: "POST",
      headers: cashfreeHeaders(),
      body: JSON.stringify({
        order_id: gatewayOrderId,
        order_amount: rules.verificationAmountPaise / 100,
        order_currency: "INR",
        customer_details: {
          customer_id: actor.id,
          customer_email: user?.email,
          customer_phone: user?.phone ?? "9999999999",
          customer_name: account.accountHolderName,
        },
        // Every method the checkout has: UPI, debit card, credit card, net banking.
        order_meta: { payment_methods: "upi,dc,cc,nb" },
        order_note: "GoKesari bank account verification — refunded automatically",
        order_tags: { purpose: "bank_verification", bank_account_id: account.id },
      }),
    });
    if (!response.ok) {
      console.error("[bank-accounts] Cashfree order failed", response.status, await response.text());
      throw new Error("Could not start the payment with Cashfree.");
    }
    paymentSessionId = ((await response.json()) as { payment_session_id: string }).payment_session_id;
  }

  const [attempt] = await db
    .insert(bankVerificationAttempts)
    .values({ bankAccountId: account.id, userId: actor.id, gateway: mode, gatewayOrderId, amountPaise: rules.verificationAmountPaise })
    .returning();
  return {
    attemptId: attempt.id,
    gatewayOrderId,
    amountPaise: attempt.amountPaise,
    mode,
    paymentSessionId,
    cashfreeMode: getEnv().CASHFREE_ENV,
  };
}

/** A payment as the gateway reports it (masked, nothing secret). */
export interface GatewayPayment {
  status: "SUCCESS" | "FAILED" | "PENDING";
  paymentId: string | null;
  method: VerificationMethod | "OTHER" | null;
  payerName: string | null;
  payerUpiId: string | null;
  payerAccountLast4: string | null;
  payerIfsc: string | null;
  cardNetwork: string | null;
  bankName: string | null;
  message: string | null;
}

type CashfreePayment = {
  cf_payment_id?: string | number;
  payment_status?: string;
  payment_group?: string;
  payment_message?: string;
  payment_method?: {
    upi?: { upi_id?: string; upi_payer_account_number?: string; upi_payer_ifsc?: string };
    card?: { card_network?: string; card_type?: string; card_bank_name?: string };
    netbanking?: { netbanking_bank_name?: string; netbanking_ifsc?: string; netbanking_account_number?: string };
  };
  customer_details?: { customer_name?: string };
  payer_name?: string;
};

const METHOD_BY_GROUP: Record<string, VerificationMethod> = {
  upi: "UPI",
  debit_card: "DEBIT_CARD",
  credit_card: "CREDIT_CARD",
  net_banking: "NET_BANKING",
};

/** Reads one Cashfree payment into GatewayPayment. */
export function readCashfreePayment(p: CashfreePayment): GatewayPayment {
  const upi = p.payment_method?.upi;
  const card = p.payment_method?.card;
  const nb = p.payment_method?.netbanking;
  const group = (p.payment_group ?? "").toLowerCase();
  const method: GatewayPayment["method"] =
    METHOD_BY_GROUP[group] ??
    (card?.card_type === "credit_card" ? "CREDIT_CARD" : card?.card_type === "debit_card" ? "DEBIT_CARD" : group ? "OTHER" : null);
  const status = p.payment_status === "SUCCESS" ? "SUCCESS" : p.payment_status === "PENDING" || p.payment_status === "NOT_ATTEMPTED" ? "PENDING" : "FAILED";
  const account = upi?.upi_payer_account_number ?? nb?.netbanking_account_number ?? null;
  return {
    status,
    paymentId: p.cf_payment_id != null ? String(p.cf_payment_id) : null,
    method,
    payerName: p.payer_name ?? null,
    payerUpiId: upi?.upi_id?.toLowerCase() ?? null,
    payerAccountLast4: account ? account.replace(/\D/g, "").slice(-4) || null : null,
    payerIfsc: (upi?.upi_payer_ifsc ?? nb?.netbanking_ifsc ?? null)?.toUpperCase() ?? null,
    cardNetwork: card?.card_network ?? null,
    bankName: card?.card_bank_name ?? nb?.netbanking_bank_name ?? null,
    message: p.payment_message ?? null,
  };
}

async function fetchCashfreePayments(gatewayOrderId: string): Promise<GatewayPayment[]> {
  const response = await fetch(`${cashfreeApiBase()}/orders/${gatewayOrderId}/payments`, { method: "GET", headers: cashfreeHeaders() });
  if (!response.ok) {
    console.error("[bank-accounts] Cashfree payments check failed", gatewayOrderId, response.status, await response.text());
    throw new Error("Could not check the payment with Cashfree. Please try again.");
  }
  return ((await response.json()) as CashfreePayment[]).map(readCashfreePayment);
}

async function refundCashfree(attempt: BankVerificationAttempt): Promise<{ status: "PENDING" | "REFUNDED" | "FAILED"; reference: string | null }> {
  try {
    const response = await fetch(`${cashfreeApiBase()}/orders/${attempt.gatewayOrderId}/refunds`, {
      method: "POST",
      headers: cashfreeHeaders(),
      body: JSON.stringify({
        refund_amount: attempt.amountPaise / 100,
        refund_id: `bvr_${attempt.id.replace(/-/g, "").slice(0, 30)}`,
        refund_note: "GoKesari bank account verification",
      }),
    });
    const body = (await response.json().catch(() => null)) as { cf_refund_id?: string | number; refund_status?: string } | null;
    if (!response.ok) {
      console.error("[bank-accounts] Cashfree refund failed", attempt.gatewayOrderId, response.status, body);
      return { status: "FAILED", reference: null };
    }
    return { status: body?.refund_status === "SUCCESS" ? "REFUNDED" : "PENDING", reference: body?.cf_refund_id != null ? String(body.cf_refund_id) : null };
  } catch (error) {
    console.error("[bank-accounts] Cashfree refund error", attempt.gatewayOrderId, error);
    return { status: "FAILED", reference: null };
  }
}

/** Decides a successful ₹1 payment against the account's details. */
export function matchPayment(
  account: Pick<BankAccount, "method" | "accountHolderName" | "accountNumberLast4" | "ifsc" | "upiIdEncrypted">,
  payment: GatewayPayment,
  threshold: number,
): { verified: boolean; matchedName: string; score: number | null; method: string; reason: string | null } {
  if (payment.payerName) {
    const score = nameMatchScore(payment.payerName, account.accountHolderName);
    if (score < threshold) {
      return { verified: false, matchedName: payment.payerName, score, method: "GATEWAY_NAME", reason: `The bank's name for the payer (${payment.payerName}) does not match ${account.accountHolderName}.` };
    }
    return { verified: true, matchedName: payment.payerName, score, method: "GATEWAY_NAME", reason: null };
  }
  if (account.method === "BANK_ACCOUNT" && payment.payerAccountLast4 && payment.payerIfsc) {
    const same = payment.payerAccountLast4 === account.accountNumberLast4 && payment.payerIfsc === account.ifsc;
    return same
      ? { verified: true, matchedName: account.accountHolderName, score: null, method: "GATEWAY_ACCOUNT", reason: null }
      : { verified: false, matchedName: account.accountHolderName, score: null, method: "GATEWAY_ACCOUNT", reason: "The ₹1 was paid from a different bank account. Pay from the account you entered." };
  }
  if (account.method === "UPI" && payment.payerUpiId && account.upiIdEncrypted) {
    const same = payment.payerUpiId === decryptSecret(account.upiIdEncrypted).toLowerCase();
    return same
      ? { verified: true, matchedName: account.accountHolderName, score: null, method: "GATEWAY_UPI", reason: null }
      : { verified: false, matchedName: account.accountHolderName, score: null, method: "GATEWAY_UPI", reason: "The ₹1 was paid from a different UPI ID. Pay from the UPI ID you entered." };
  }
  return { verified: true, matchedName: account.accountHolderName, score: null, method: "PAYMENT_ONLY", reason: null };
}

async function loadOwnAttempt(gatewayOrderId: string, actor: Actor): Promise<{ attempt: BankVerificationAttempt; account: BankAccount }> {
  const [attempt] = await db.select().from(bankVerificationAttempts).where(eq(bankVerificationAttempts.gatewayOrderId, gatewayOrderId));
  if (!attempt || attempt.userId !== actor.id) throw notFound("Verification");
  const [account] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, attempt.bankAccountId));
  if (!account) throw notFound("Bank account");
  return { attempt, account };
}

/**
 * Records the outcome of an attempt (once — a repeated call returns the
 * stored result): the account becomes VERIFIED or FAILED, the ₹1 is refunded,
 * the holder is told.
 */
async function settleAttempt(
  attempt: BankVerificationAttempt,
  account: BankAccount,
  payment: GatewayPayment,
  actor: Actor,
  refund: () => Promise<{ status: "PENDING" | "REFUNDED" | "FAILED"; reference: string | null }>,
): Promise<BankAccountView> {
  const rules = await getRule("bankAccounts");
  const paid = payment.status === "SUCCESS";
  const decision = paid ? matchPayment(account, payment, rules.nameMatchThreshold) : null;
  const verified = decision?.verified === true;
  const reason = paid ? decision!.reason : payment.message?.trim() || "The payment was not completed.";
  const payerDetails = {
    name: payment.payerName,
    upi: payment.payerUpiId ? maskUpiId(payment.payerUpiId) : null,
    accountLast4: payment.payerAccountLast4,
    ifsc: payment.payerIfsc,
    cardNetwork: payment.cardNetwork,
    bank: payment.bankName,
  };

  const settled = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(bankVerificationAttempts)
      .set({
        status: paid ? "SUCCESS" : "FAILED",
        paymentMethod: payment.method,
        gatewayPaymentId: payment.paymentId,
        payerDetails,
        failureReason: verified ? null : reason,
        refundStatus: paid ? "PENDING" : "NOT_REQUIRED",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(bankVerificationAttempts.id, attempt.id), eq(bankVerificationAttempts.status, "CREATED")))
      .returning();
    if (!claimed) return null;
    // A replaced account keeps its own history but no longer changes status.
    if (account.isCurrent && account.status !== "VERIFIED") {
      await tx
        .update(bankAccounts)
        .set({
          status: verified ? "VERIFIED" : "FAILED",
          matchedAccountHolderName: paid ? decision!.matchedName : null,
          nameMatchScore: decision?.score ?? null,
          matchMethod: decision?.method ?? null,
          verifiedAt: verified ? new Date() : null,
          verificationPaymentMethod: payment.method,
          gatewayReference: payment.paymentId,
          failureReason: verified ? null : reason,
          updatedAt: new Date(),
        })
        .where(eq(bankAccounts.id, account.id));
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: verified ? AUDIT_ACTIONS.BANK_ACCOUNT_VERIFIED : AUDIT_ACTIONS.BANK_ACCOUNT_VERIFICATION_FAILED,
        entityType: "bank_account",
        entityId: account.id,
        newValue: { gateway: attempt.gateway, gatewayPaymentId: payment.paymentId, method: payment.method, matchMethod: decision?.method ?? null, reason },
      },
      tx,
    );
    await emitEvent(
      {
        type: verified ? "bank_account.verified" : "bank_account.verification_failed",
        subjectId: account.id,
        actor,
        payload: { userId: account.userId, accountLabel: label(account), reason, forShop: account.shopId != null },
        idempotencyKey: `bank-verification:${attempt.id}`,
      },
      tx,
    );
    return claimed;
  });

  // The ₹1 goes back whatever the outcome; a failed refund is retried from finance.
  if (settled && paid) {
    const result = await refund();
    await db
      .update(bankVerificationAttempts)
      .set({ refundStatus: result.status, refundReference: result.reference, refundedAt: result.status === "REFUNDED" ? new Date() : null, updatedAt: new Date() })
      .where(eq(bankVerificationAttempts.id, attempt.id));
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.BANK_ACCOUNT_REFUND,
      entityType: "bank_account",
      entityId: account.id,
      newValue: { attemptId: attempt.id, refundStatus: result.status, refundReference: result.reference },
    });
  }
  const [fresh] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, account.id));
  return toView(fresh);
}

/** After the checkout closes: Cashfree is asked what happened (never the browser). */
export async function confirmBankVerification(gatewayOrderId: string, actor: Actor): Promise<BankAccountView> {
  const { attempt, account } = await loadOwnAttempt(gatewayOrderId, actor);
  if (attempt.status !== "CREATED") return toView(account);
  if (attempt.gateway !== "CASHFREE") throw conflict("Finish the test payment first.");
  const payments = await fetchCashfreePayments(gatewayOrderId);
  const success = payments.find((p) => p.status === "SUCCESS");
  if (!success && payments.some((p) => p.status === "PENDING")) {
    throw conflict("The payment is still being processed. Check again in a minute.", { pending: true });
  }
  const payment: GatewayPayment = success ?? payments.at(-1) ?? {
    status: "FAILED",
    paymentId: null,
    method: null,
    payerName: null,
    payerUpiId: null,
    payerAccountLast4: null,
    payerIfsc: null,
    cardNetwork: null,
    bankName: null,
    message: "The payment was not completed.",
  };
  // A failed attempt's id is not unique proof of anything; keep only successful payment ids.
  return settleAttempt(attempt, account, success ? payment : { ...payment, paymentId: null }, actor, () => refundCashfree(attempt));
}

/**
 * The test gateway (no Cashfree keys; never on gokesari.com): the tester picks
 * the method and the outcome, and the same matching, recording, refund and
 * notifications run as for a real payment.
 */
export async function simulateBankVerification(
  gatewayOrderId: string,
  input: { method: VerificationMethod; outcome: "SUCCESS" | "FAILED" | "NAME_MISMATCH" },
  actor: Actor,
): Promise<BankAccountView> {
  if (verificationGatewayMode() !== "SIMULATOR") throw notFound("Verification");
  const { attempt, account } = await loadOwnAttempt(gatewayOrderId, actor);
  if (attempt.gateway !== "SIMULATOR") throw notFound("Verification");
  if (attempt.status !== "CREATED") return toView(account);
  const payment: GatewayPayment = {
    status: input.outcome === "FAILED" ? "FAILED" : "SUCCESS",
    paymentId: input.outcome === "FAILED" ? null : `sim_${crypto.randomBytes(6).toString("hex")}`,
    method: input.method,
    payerName: input.outcome === "NAME_MISMATCH" ? "Different Account Holder" : input.method === "UPI" || input.method === "NET_BANKING" ? account.accountHolderName : null,
    payerUpiId: null,
    payerAccountLast4: null,
    payerIfsc: null,
    cardNetwork: input.method.endsWith("CARD") ? "VISA" : null,
    bankName: input.method === "NET_BANKING" ? "Test Bank" : null,
    message: input.outcome === "FAILED" ? "Payment declined by the bank (test)." : null,
  };
  return settleAttempt(attempt, account, payment, actor, async () => ({ status: "REFUNDED", reference: `sim_refund_${attempt.id.slice(0, 8)}` }));
}

/* ============================================================== gates */

/**
 * Shop payouts (rule bankAccounts.requireVerifiedForShopPayouts): a settlement
 * is sent to the bank or marked paid only for a shop with a verified account.
 */
export async function assertSettlementPayoutAllowed(settlementId: string, action: string): Promise<void> {
  if (action !== "process" && action !== "pay") return;
  const rules = await getRule("bankAccounts");
  if (!rules.requireVerifiedForShopPayouts) return;
  const [row] = await db
    .select({ shopId: shopSettlements.shopId, shopName: shops.name })
    .from(shopSettlements)
    .innerJoin(shops, eq(shops.id, shopSettlements.shopId))
    .where(eq(shopSettlements.id, settlementId));
  if (!row) return; // the settlement service reports the missing row
  const [account] = await db
    .select({ status: bankAccounts.status })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.shopId, row.shopId), eq(bankAccounts.isCurrent, true)));
  if (account?.status !== "VERIFIED") {
    throw conflict(`${row.shopName} has no verified bank account yet — the payout is on hold until the owner verifies one.`, {
      bankAccountStatus: account?.status ?? "NONE",
    });
  }
}

/**
 * Refunds to a customer's bank (rule bankAccounts.requireVerifiedForBankRefunds).
 * Refunds go to the GoKesari wallet today; any refund sent to a bank must call
 * this first. Returns the verified account.
 */
export async function assertCustomerBankRefundAllowed(userId: string): Promise<BankAccount | null> {
  const rules = await getRule("bankAccounts");
  const account = await currentBankAccount(userId, null);
  if (rules.requireVerifiedForBankRefunds && account?.status !== "VERIFIED") {
    throw conflict("Add and verify a bank account in My Profile to receive refunds to your bank.");
  }
  return account;
}

/* ============================================================ finance */

export interface BankAccountAdminRow extends BankAccountView {
  ownerName: string | null;
  ownerEmail: string;
  shopName: string | null;
  createdAt: string;
}

export async function listBankAccountsForFinance(filter: { status?: BankAccount["status"]; holderType?: "CUSTOMER" | "SHOP" }, actor: Actor): Promise<BankAccountAdminRow[]> {
  if (!can(actor.role, PERMISSIONS.FINANCE_VIEW)) throw forbidden("You do not have access to bank accounts.");
  const rows = await db
    .select({ account: bankAccounts, ownerName: users.name, ownerEmail: users.email, shopName: shops.name })
    .from(bankAccounts)
    .innerJoin(users, eq(users.id, bankAccounts.userId))
    .leftJoin(shops, eq(shops.id, bankAccounts.shopId))
    .where(
      and(
        eq(bankAccounts.isCurrent, true),
        filter.status ? eq(bankAccounts.status, filter.status) : undefined,
        filter.holderType ? eq(bankAccounts.holderType, filter.holderType) : undefined,
      ),
    )
    .orderBy(desc(bankAccounts.updatedAt))
    .limit(500);
  return Promise.all(
    rows.map(async (r) => ({
      ...(await toView(r.account)),
      ownerName: r.ownerName,
      ownerEmail: r.ownerEmail,
      shopName: r.shopName,
      createdAt: r.account.createdAt.toISOString(),
    })),
  );
}

/** Shops (owned by the user) and whether each has a verified payout account — for prompts. */
export async function shopBankStatus(shopId: string): Promise<BankAccount["status"] | "NONE"> {
  const [account] = await db
    .select({ status: bankAccounts.status })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.shopId, shopId), eq(bankAccounts.isCurrent, true)));
  return account?.status ?? "NONE";
}

/**
 * Prompts (never a lockout). The customer is prompted at their first checkout
 * (no orders yet) and in My Profile; null = no prompt (rule off or verified).
 */
export async function customerBankPrompt(userId: string, where: "checkout" | "profile"): Promise<BankAccount["status"] | "NONE" | null> {
  if (!(await getRule("bankAccounts")).enabled) return null;
  const account = await currentBankAccount(userId, null);
  if (account?.status === "VERIFIED") return where === "profile" ? "VERIFIED" : null;
  if (where === "checkout") {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(orders).where(eq(orders.userId, userId));
    if (n > 0) return null;
  }
  return account?.status ?? "NONE";
}

/** The shop dashboard's prompt; null = none (rule off). */
export async function shopBankPrompt(shopId: string): Promise<BankAccount["status"] | "NONE" | null> {
  if (!(await getRule("bankAccounts")).enabled) return null;
  return shopBankStatus(shopId);
}
