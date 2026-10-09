/**
 * Bank account check with Cashfree's Verification Suite (docs/four-features-2026-10,
 * the owner's decision O-7, rule bankAccountCheck).
 *
 * When a bank account (account number + IFSC) is saved, the bank is asked,
 * through Cashfree's Bank Account Verification (sync, v2), whether the account
 * is valid and whose name it is in:
 *   - valid, and the name matches (Cashfree's own match, or our
 *     bankAccounts.nameMatchThreshold) → the account is VERIFIED at once,
 *     without the ₹1 payment;
 *   - invalid (wrong number or IFSC, blocked, NRE), or a name that does not
 *     match → FAILED, with the reason and the bank's name for the account;
 *     the ₹1 payment cannot then override the bank (correct the details);
 *   - any error (keys missing, Cashfree's 2FA refusing, a timeout) → nothing
 *     changes: the account waits for the ₹1 check, as before.
 * UPI IDs keep the ₹1 check. Every call is kept in bank_account_checks.
 *
 * Keys come from the environment only (CASHFREE_VERIFICATION_*). Cashfree
 * needs two-factor authentication even in its sandbox: either this server's IP
 * is whitelisted in the Cashfree dashboard, or CASHFREE_VERIFICATION_PUBLIC_KEY
 * holds the Secure ID public key and every call carries a signature.
 */
import crypto from "node:crypto";

import { and, desc, eq, gte, ne } from "drizzle-orm";

import { maskAccountNumber } from "@/lib/bank-accounts";
import { findCashfreeVerificationKeys, getEnv, type ServerEnv } from "@/lib/env";
import { AppError, conflict, forbidden, notFound } from "@/lib/errors";
import { nameMatchScore } from "@/lib/kyc/name-match";
import { decryptSecret } from "@/lib/pan-crypto";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { bankAccountChecks, bankAccounts, type BankAccount, type BankAccountCheck, type UserRole } from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

/* ============================================================ config */

export interface BankCheckConfig {
  clientId: string;
  clientSecret: string;
  publicKey: string | null;
  env: "sandbox" | "production";
  /** Which variable names held the id and secret (never their values). */
  foundAs: { clientId: string; clientSecret: string };
}

const KEY_NAMES = [
  ["CASHFREE_VERIFICATION_CLIENT_ID", "CASHFREE_VERIFICATION_CLIENT_SECRET"],
  ["CASHFREE_VERIFICATION_APP_ID", "CASHFREE_VERIFICATION_SECRET_KEY"],
] as const;

/** A PEM pasted into a host's settings often arrives with literal "\n"s. */
function normalizePem(raw: string | undefined): string | null {
  const value = raw?.replace(/\\n/g, "\n").trim();
  return value ? value : null;
}

/** The Verification Suite keys, or null when they are not set. */
export function bankCheckConfig(env: ServerEnv = getEnv(), other: ReturnType<typeof findCashfreeVerificationKeys> = findCashfreeVerificationKeys()): BankCheckConfig | null {
  for (const [idName, secretName] of KEY_NAMES) {
    const clientId = env[idName];
    const clientSecret = env[secretName];
    if (clientId && clientSecret) {
      return {
        clientId,
        clientSecret,
        publicKey: normalizePem(env.CASHFREE_VERIFICATION_PUBLIC_KEY),
        env: env.CASHFREE_VERIFICATION_ENV ?? env.CASHFREE_ENV,
        foundAs: { clientId: idName, clientSecret: secretName },
      };
    }
  }
  // Keys saved on the host under another name (see findCashfreeVerificationKeys).
  if (other) {
    return {
      clientId: other.clientId,
      clientSecret: other.clientSecret,
      publicKey: normalizePem(env.CASHFREE_VERIFICATION_PUBLIC_KEY),
      env: env.CASHFREE_VERIFICATION_ENV ?? env.CASHFREE_ENV,
      foundAs: { clientId: other.idName, clientSecret: other.secretName },
    };
  }
  return null;
}

export function bankCheckApiBase(env: "sandbox" | "production"): string {
  return env === "production" ? "https://api.cashfree.com/verification" : "https://sandbox.cashfree.com/verification";
}

/** Cashfree's 2FA signature: "<client id>.<unix seconds>", RSA-OAEP (SHA-1) with the Secure ID public key, base64. */
export function cashfreeSignature(clientId: string, publicKeyPem: string, now: number = Date.now()): string {
  const data = Buffer.from(`${clientId}.${Math.floor(now / 1000)}`);
  return crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, data).toString("base64");
}

/* ======================================================== the call */

export interface BavOutcome {
  result: "VALID" | "INVALID" | "ERROR";
  httpStatus: number | null;
  statusCode: string | null;
  referenceId: string | null;
  nameAtBank: string | null;
  bankName: string | null;
  branch: string | null;
  city: string | null;
  nameMatchScore: number | null;
  nameMatchResult: string | null;
  errorMessage: string | null;
}

interface BavResponse {
  reference_id?: string | number;
  name_at_bank?: string | null;
  bank_name?: string | null;
  city?: string | null;
  branch?: string | null;
  name_match_score?: string | number | null;
  name_match_result?: string | null;
  account_status?: string | null;
  account_status_code?: string | null;
  message?: string;
  code?: string;
  type?: string;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

function errorOutcome(httpStatus: number | null, message: string): BavOutcome {
  return {
    result: "ERROR",
    httpStatus,
    statusCode: null,
    referenceId: null,
    nameAtBank: null,
    bankName: null,
    branch: null,
    city: null,
    nameMatchScore: null,
    nameMatchResult: null,
    errorMessage: message.slice(0, 500),
  };
}

/** Bank Account Verification (sync, v2): POST {base}/bank-account/sync. Never throws. */
export async function callCashfreeBav(config: BankCheckConfig, input: { accountNumber: string; ifsc: string; name: string }): Promise<BavOutcome> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-client-id": config.clientId,
    "x-client-secret": config.clientSecret,
  };
  try {
    if (config.publicKey) headers["x-cf-signature"] = cashfreeSignature(config.clientId, config.publicKey);
  } catch (error) {
    return errorOutcome(null, `CASHFREE_VERIFICATION_PUBLIC_KEY could not be used (${error instanceof Error ? error.message : String(error)}).`);
  }
  let response: Response;
  try {
    response = await fetch(`${bankCheckApiBase(config.env)}/bank-account/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({ bank_account: input.accountNumber, ifsc: input.ifsc, name: input.name }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return errorOutcome(null, `Could not reach Cashfree (${error instanceof Error ? error.message : String(error)}).`);
  }
  const body = (await response.json().catch(() => null)) as BavResponse | null;
  if (!response.ok) {
    const detail = [body?.code, body?.message].filter(Boolean).join(": ") || "no details";
    const hint =
      response.status === 401 || response.status === 403
        ? " Check the Verification Suite keys and its two-factor authentication: whitelist this server's IP in Cashfree, or set CASHFREE_VERIFICATION_PUBLIC_KEY."
        : "";
    return errorOutcome(response.status, `Cashfree answered ${response.status} (${detail}).${hint}`);
  }
  const status = String(body?.account_status ?? "").toUpperCase();
  const rawScore = body?.name_match_score;
  const score = rawScore == null || rawScore === "" ? null : Number(rawScore);
  return {
    result: status === "VALID" ? "VALID" : status === "INVALID" ? "INVALID" : "ERROR",
    httpStatus: response.status,
    statusCode: text(body?.account_status_code),
    referenceId: text(body?.reference_id),
    nameAtBank: text(body?.name_at_bank),
    bankName: text(body?.bank_name),
    branch: text(body?.branch),
    city: text(body?.city),
    nameMatchScore: score != null && Number.isFinite(score) ? Math.round(score) : null,
    nameMatchResult: text(body?.name_match_result),
    errorMessage: status === "VALID" || status === "INVALID" ? null : `Unexpected answer from Cashfree (account_status ${status || "missing"}).`,
  };
}

/* ======================================================== decision */

const GOOD_BANDS = new Set(["DIRECT_MATCH", "GOOD_PARTIAL_MATCH"]);
const BAD_BANDS = new Set(["POOR_PARTIAL_MATCH", "NO_MATCH"]);

const INVALID_REASONS: Record<string, string> = {
  INVALID_ACCOUNT_FAIL: "the bank says this account number is not valid",
  INVALID_IFSC_FAIL: "the IFSC is not valid for this account",
  ACCOUNT_BLOCKED: "the bank says this account is blocked",
  NRE_ACCOUNT_FAIL: "NRE accounts cannot be used",
};

/** Whether the bank's answer verifies the account, the score kept, and the reason shown. */
export function bankCheckDecision(
  outcome: Pick<BavOutcome, "result" | "statusCode" | "nameAtBank" | "nameMatchScore" | "nameMatchResult">,
  declaredName: string,
  threshold: number,
): { decided: boolean; verified: boolean; score: number | null; reason: string | null } {
  if (outcome.result === "INVALID") {
    return {
      decided: true,
      verified: false,
      score: null,
      reason: INVALID_REASONS[outcome.statusCode ?? ""] ?? "the bank could not confirm this account",
    };
  }
  if (outcome.result !== "VALID") return { decided: false, verified: false, score: null, reason: null };
  const band = outcome.nameMatchResult?.toUpperCase() ?? null;
  const providerScore = outcome.nameMatchScore;
  // A valid account with no word on the name: the ₹1 check still decides.
  if (band == null && providerScore == null && !outcome.nameAtBank) return { decided: false, verified: false, score: null, reason: null };
  // Cashfree compares the name with the bank's records; our own score is used only when it gives neither.
  const ownScore = outcome.nameAtBank ? nameMatchScore(declaredName, outcome.nameAtBank) : 0;
  const score = providerScore ?? (band ? null : ownScore);
  const matches =
    (band != null && GOOD_BANDS.has(band)) ||
    (band == null || !BAD_BANDS.has(band) ? (score ?? 0) >= threshold : false);
  if (matches) {
    return { decided: true, verified: true, score, reason: outcome.nameAtBank ? `name at bank: ${outcome.nameAtBank}` : null };
  }
  return {
    decided: true,
    verified: false,
    score,
    reason: outcome.nameAtBank
      ? `the bank has this account in the name "${outcome.nameAtBank}", which does not match "${declaredName}"`
      : "the bank did not confirm the account holder's name",
  };
}

/* ========================================================== running */

const label = (account: BankAccount) => `Account ${maskAccountNumber(account.accountNumberLast4)} (${account.ifsc})`;

async function checksToday(userId: string): Promise<number> {
  const rows = await db
    .select({ id: bankAccountChecks.id })
    .from(bankAccountChecks)
    .where(and(eq(bankAccountChecks.userId, userId), ne(bankAccountChecks.result, "NOT_CONFIGURED"), gte(bankAccountChecks.createdAt, new Date(Date.now() - 86_400_000))));
  return rows.length;
}

/**
 * Checks the account with the bank and records the result. Returns null when
 * nothing was checked (rule off, a UPI ID, already verified, the daily limit
 * on an automatic check). trigger "RETRY" (the holder asking again) throws
 * instead of returning null, so the reason reaches them.
 */
export async function runBankAccountCheck(accountId: string, actor: Actor, trigger: "SAVE" | "RETRY"): Promise<BankAccountCheck | null> {
  const rule = await getRule("bankAccountCheck");
  const fail = (message: string) => {
    if (trigger === "RETRY") throw conflict(message);
    return null;
  };
  if (!rule.enabled) return fail("Checking with the bank is not switched on.");
  const [account] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, accountId));
  if (!account) throw notFound("Bank account");
  if (trigger === "RETRY" && account.userId !== actor.id) throw notFound("Bank account");
  if (account.method !== "BANK_ACCOUNT" || !account.accountNumberEncrypted || !account.ifsc) return fail("Only a bank account (not a UPI ID) can be checked with the bank.");
  if (!account.isCurrent) return fail("These details were replaced — check the current account.");
  if (account.status === "VERIFIED") return fail("This account is already verified.");
  if ((await checksToday(actor.id)) >= rule.maxChecksPerDay) {
    if (trigger === "RETRY") throw new AppError("RATE_LIMITED", `The bank can be asked ${rule.maxChecksPerDay} times a day. Verify with ₹1 instead, or try tomorrow.`);
    return null;
  }

  const config = bankCheckConfig();
  const outcome: BavOutcome = config
    ? await callCashfreeBav(config, { accountNumber: decryptSecret(account.accountNumberEncrypted), ifsc: account.ifsc, name: account.accountHolderName })
    : { ...errorOutcome(null, "The Verification Suite keys are not set on this site."), result: "ERROR" };
  const decision = bankCheckDecision(outcome, account.accountHolderName, (await getRule("bankAccounts")).nameMatchThreshold);
  const result = config ? outcome.result : "NOT_CONFIGURED";

  return db.transaction(async (tx) => {
    const [check] = await tx
      .insert(bankAccountChecks)
      .values({
        bankAccountId: account.id,
        userId: actor.id,
        result,
        statusCode: outcome.statusCode,
        referenceId: outcome.referenceId,
        nameAtBank: outcome.nameAtBank,
        bankName: outcome.bankName,
        branch: outcome.branch,
        city: outcome.city,
        nameMatchScore: decision.score ?? outcome.nameMatchScore,
        nameMatchResult: outcome.nameMatchResult,
        verified: decision.verified,
        httpStatus: outcome.httpStatus,
        errorMessage: outcome.errorMessage,
      })
      .returning();
    let changed = false;
    if (decision.decided) {
      const [updated] = await tx
        .update(bankAccounts)
        .set({
          status: decision.verified ? "VERIFIED" : "FAILED",
          matchedAccountHolderName: outcome.nameAtBank,
          nameMatchScore: decision.score,
          matchMethod: "BANK_CHECK",
          verifiedAt: decision.verified ? new Date() : null,
          verificationPaymentMethod: null,
          gatewayReference: outcome.referenceId,
          failureReason: decision.verified ? null : decision.reason,
          updatedAt: new Date(),
        })
        // Only the current, not-yet-verified account changes (a ₹1 check may have won meanwhile).
        .where(and(eq(bankAccounts.id, account.id), eq(bankAccounts.isCurrent, true), ne(bankAccounts.status, "VERIFIED")))
        .returning({ id: bankAccounts.id });
      changed = Boolean(updated);
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.BANK_ACCOUNT_CHECKED,
        entityType: "bank_account",
        entityId: account.id,
        newValue: {
          trigger,
          result,
          statusCode: outcome.statusCode,
          nameMatchResult: outcome.nameMatchResult,
          nameMatchScore: check.nameMatchScore,
          verified: decision.verified,
          httpStatus: outcome.httpStatus,
          referenceId: outcome.referenceId,
        },
      },
      tx,
    );
    if (changed) {
      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: decision.verified ? AUDIT_ACTIONS.BANK_ACCOUNT_VERIFIED : AUDIT_ACTIONS.BANK_ACCOUNT_VERIFICATION_FAILED,
          entityType: "bank_account",
          entityId: account.id,
          newValue: { matchMethod: "BANK_CHECK", checkId: check.id, reason: decision.reason },
        },
        tx,
      );
      await emitEvent(
        {
          type: decision.verified ? "bank_account.bank_check_verified" : "bank_account.bank_check_failed",
          subjectId: account.id,
          actor,
          payload: { userId: account.userId, accountLabel: label(account), reason: decision.reason, forShop: account.shopId != null },
          idempotencyKey: `bank-check:${check.id}`,
        },
        tx,
      );
    }
    return check;
  });
}

/** Saving never fails because of the bank check: errors are logged and the ₹1 check remains. */
export async function runBankAccountCheckOnSave(accountId: string, actor: Actor): Promise<void> {
  try {
    await runBankAccountCheck(accountId, actor, "SAVE");
  } catch (error) {
    console.error("[bank-account-check] check after save failed", accountId, error);
  }
}

/** The ₹1 payment cannot override the bank: after a definite "no" the details must be corrected first. */
export async function assertNoFailedBankCheck(account: Pick<BankAccount, "id" | "status" | "matchMethod">): Promise<void> {
  if (account.status === "FAILED" && account.matchMethod === "BANK_CHECK") {
    throw conflict("Your bank did not confirm these details. Correct them (use the name and number your bank has), then save again.");
  }
}

/* ============================================================== views */

export interface BankCheckView {
  result: BankAccountCheck["result"];
  verified: boolean;
  nameAtBank: string | null;
  bankName: string | null;
  branch: string | null;
  city: string | null;
  nameMatchScore: number | null;
  nameMatchResult: string | null;
  checkedAt: string;
}

/** The latest check of an account, as the holder sees it (no technical error text). */
export async function latestBankCheck(accountId: string): Promise<BankCheckView | null> {
  const [row] = await db.select().from(bankAccountChecks).where(eq(bankAccountChecks.bankAccountId, accountId)).orderBy(desc(bankAccountChecks.createdAt)).limit(1);
  if (!row) return null;
  return {
    result: row.result,
    verified: row.verified,
    nameAtBank: row.nameAtBank,
    bankName: row.bankName,
    branch: row.branch,
    city: row.city,
    nameMatchScore: row.nameMatchScore,
    nameMatchResult: row.nameMatchResult,
    checkedAt: row.createdAt.toISOString(),
  };
}

/** Whether the holder's page should offer the bank check at all. */
export async function bankCheckOffered(): Promise<boolean> {
  return (await getRule("bankAccountCheck")).enabled && bankCheckConfig() != null;
}

/* ============================================================== admin */

export interface BankCheckAdminStatus {
  enabled: boolean;
  configured: boolean;
  env: "sandbox" | "production" | null;
  foundAs: { clientId: string; clientSecret: string } | null;
  twoFactor: "SIGNATURE" | "IP_WHITELIST" | null;
  expectedNames: string[];
  recent: { result: string; statusCode: string | null; httpStatus: number | null; errorMessage: string | null; nameMatchResult: string | null; verified: boolean; createdAt: string }[];
}

function assertFinance(actor: Actor, manage = false) {
  if (!can(actor.role, manage ? PERMISSIONS.FINANCE_MANAGE : PERMISSIONS.FINANCE_VIEW)) throw forbidden("You do not have access to bank account checks.");
}

export async function bankCheckAdminStatus(actor: Actor): Promise<BankCheckAdminStatus> {
  assertFinance(actor);
  const config = bankCheckConfig();
  const recent = await db.select().from(bankAccountChecks).orderBy(desc(bankAccountChecks.createdAt)).limit(5);
  return {
    enabled: (await getRule("bankAccountCheck")).enabled,
    configured: config != null,
    env: config?.env ?? null,
    foundAs: config?.foundAs ?? null,
    twoFactor: config ? (config.publicKey ? "SIGNATURE" : "IP_WHITELIST") : null,
    expectedNames: [...KEY_NAMES.flat(), "CASHFREE_CLIENT_ID", "CASHFREE_CLIENT_SECRET", "CASHFREE_VERIFICATION_PUBLIC_KEY", "CASHFREE_VERIFICATION_ENV"],
    recent: recent.map((r) => ({
      result: r.result,
      statusCode: r.statusCode,
      httpStatus: r.httpStatus,
      errorMessage: r.errorMessage,
      nameMatchResult: r.nameMatchResult,
      verified: r.verified,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/** Cashfree's own sandbox sample account (its BAV docs), used only for the connection test. */
export const SANDBOX_SAMPLE_ACCOUNT = { accountNumber: "026291800001191", ifsc: "YESB0000262", name: "John Doe" } as const;

async function outboundIp(): Promise<string | null> {
  try {
    const response = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(5000) });
    return ((await response.json()) as { ip?: string }).ip ?? null;
  } catch {
    return null;
  }
}

/**
 * Finance: a test call with Cashfree's sandbox sample account (sandbox keys
 * only — a production check costs a fee and needs a real account). Shows
 * what Cashfree answered and this server's outbound IP, for whitelisting.
 */
export async function testBankCheckConnection(actor: Actor): Promise<{ configured: boolean; env: string | null; outboundIp: string | null; outcome: BavOutcome | null }> {
  assertFinance(actor, true);
  const config = bankCheckConfig();
  const ip = await outboundIp();
  if (!config) return { configured: false, env: null, outboundIp: ip, outcome: null };
  if (config.env !== "sandbox") throw conflict("The connection test uses Cashfree's sandbox sample account, so it runs with sandbox keys only.");
  const outcome = await callCashfreeBav(config, SANDBOX_SAMPLE_ACCOUNT);
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.BANK_ACCOUNT_CHECKED,
    entityType: "bank_account_check_test",
    entityId: actor.id,
    newValue: { result: outcome.result, httpStatus: outcome.httpStatus, statusCode: outcome.statusCode, error: outcome.errorMessage },
  });
  return { configured: true, env: config.env, outboundIp: ip, outcome };
}
