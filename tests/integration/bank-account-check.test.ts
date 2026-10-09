/**
 * Bank account check with Cashfree's Verification Suite (the owner's decision
 * O-7, rule bankAccountCheck), with Cashfree's API mocked.
 *
 * A bank account is checked when saved: valid + matching name → verified
 * without the ₹1 payment; invalid or a name mismatch → failed with the reason
 * (and the ₹1 payment refused until the details change); an error (2FA,
 * timeout) or missing keys → nothing changes and the ₹1 check remains.
 * Rule off, UPI IDs and the daily limit; the retry route; the 2FA signature;
 * finance's status and connection test.
 */
import crypto from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
  keys: null as null | Record<string, string>,
}));

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async () => {},
  EmailUnavailableError: class extends Error {},
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

// The Verification Suite keys are switched on per test.
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, getEnv: () => ({ ...actual.getEnv(), ...(state.keys ?? {}) }) };
});

import { PUT as myAccountPut } from "@/app/api/bank-account/route";
import { POST as checkRoute } from "@/app/api/bank-account/check/route";
import { POST as startRoute } from "@/app/api/bank-account/verification/route";
import { GET as adminStatusRoute } from "@/app/api/admin/bank-account-check/route";
import { POST as adminTestRoute } from "@/app/api/admin/bank-account-check/test/route";
import { PUT as shopAccountPut } from "@/app/api/shops/[id]/bank-account/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { bankAccountChecks, bankAccounts, notifications, platformSettings } from "@/server/db/schema";
import { findCashfreeVerificationKeys } from "@/lib/env";
import { bankCheckConfig, bankCheckDecision, cashfreeSignature } from "@/server/services/bank-account-check";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

let admin = { id: "", role: "ADMIN" as const };
const realFetch = global.fetch;

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
let calls: Captured[] = [];

/** Cashfree's answer to the next bank check(s). */
function cashfree(status: number, body: Record<string, unknown>) {
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.ipify.org")) return new Response(JSON.stringify({ ip: "203.0.113.7" }), { status: 200 });
    calls.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const VALID_MATCH = {
  reference_id: 34567,
  name_at_bank: "RAVI KUMAR",
  bank_name: "STATE BANK OF INDIA",
  city: "PUNE",
  branch: "SHIVAJINAGAR",
  micr: 411002001,
  name_match_score: "95.00",
  name_match_result: "DIRECT_MATCH",
  account_status: "VALID",
  account_status_code: "ACCOUNT_IS_VALID",
};

const KEYS = { CASHFREE_VERIFICATION_CLIENT_ID: "CF-verify-id", CASHFREE_VERIFICATION_CLIENT_SECRET: "cf-verify-secret" };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["bankAccounts", "bankAccountCheck"]));
  clearRuleCache();
  resetRateLimits();
  calls = [];
  state.session = null;
  state.keys = { ...KEYS };
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await setRule("bankAccounts", { enabled: true }, admin);
  await setRule("bankAccountCheck", { enabled: true }, admin);
});

afterEach(() => {
  global.fetch = realFetch;
});

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

const BANK = { method: "BANK_ACCOUNT", accountHolderName: "Ravi Kumar", accountNumber: "123456789012", confirmAccountNumber: "123456789012", ifsc: "SBIN0001234" };

const saveMine = (body: Record<string, unknown> = BANK) => call(myAccountPut, "/api/bank-account", { method: "PUT", body });
const startRupee = (accountId: string) => call(startRoute, "/api/bank-account/verification", { method: "POST", body: { accountId } });
const checkAgain = (accountId: string) => call(checkRoute, "/api/bank-account/check", { method: "POST", body: { accountId } });

async function signedInCustomer() {
  const customer = await createUser({ name: "Ravi Kumar" });
  signIn(customer, "CUSTOMER");
  return customer;
}

const checksOf = (accountId: string) => db.select().from(bankAccountChecks).where(eq(bankAccountChecks.bankAccountId, accountId));
const notified = (userId: string, type: string) => db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type)));

/* ------------------------------------------------------------------ saving */

describe("checking a bank account when it is saved", () => {
  it("valid and the name matches: verified at once, no ₹1 payment; the holder is told", async () => {
    const customer = await signedInCustomer();
    cashfree(200, VALID_MATCH);
    const saved = await saveMine();
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({
      status: "VERIFIED",
      matchMethod: "BANK_CHECK",
      matchedAccountHolderName: "RAVI KUMAR",
      gatewayReference: "34567",
      verificationPaymentMethod: null,
      bankCheck: { result: "VALID", verified: true, bankName: "STATE BANK OF INDIA", branch: "SHIVAJINAGAR", nameMatchResult: "DIRECT_MATCH" },
    });
    expect(saved.body.verifiedAt).not.toBeNull();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://sandbox.cashfree.com/verification/bank-account/sync");
    expect(calls[0].headers).toMatchObject({ "x-client-id": "CF-verify-id", "x-client-secret": "cf-verify-secret" });
    expect(calls[0].headers["x-cf-signature"]).toBeUndefined();
    expect(calls[0].body).toEqual({ bank_account: "123456789012", ifsc: "SBIN0001234", name: "Ravi Kumar" });

    const [check] = await checksOf(saved.body.id);
    expect(check).toMatchObject({ provider: "CASHFREE_BAV", result: "VALID", statusCode: "ACCOUNT_IS_VALID", verified: true, nameMatchScore: 95, httpStatus: 200 });
    const [notice] = await notified(customer.id, "wallet.bank_account_verified");
    expect(notice.body).toContain("No ₹1 payment was needed");

    // Verified: nothing more to pay.
    expect((await startRupee(saved.body.id)).status).toBe(409);
  });

  it("valid but another person's name: failed with the bank's name, and the ₹1 payment cannot override it", async () => {
    const customer = await signedInCustomer();
    cashfree(200, { ...VALID_MATCH, name_at_bank: "SUNITA DESHMUKH", name_match_score: "12.00", name_match_result: "NO_MATCH" });
    const saved = await saveMine();
    expect(saved.body).toMatchObject({ status: "FAILED", matchMethod: "BANK_CHECK", matchedAccountHolderName: "SUNITA DESHMUKH" });
    expect(saved.body.failureReason).toContain('"SUNITA DESHMUKH"');
    expect((await notified(customer.id, "wallet.bank_account_verification_failed"))[0].body).toContain("verify with ₹1 instead");

    const rupee = await startRupee(saved.body.id);
    expect(rupee.status).toBe(409);
    expect(rupee.body.error.message).toContain("Your bank did not confirm these details");

    // Corrected details: a new account, checked again.
    cashfree(200, VALID_MATCH);
    const fixed = await saveMine({ ...BANK, accountNumber: "123456789099", confirmAccountNumber: "123456789099" });
    expect(fixed.body).toMatchObject({ status: "VERIFIED", matchMethod: "BANK_CHECK" });
    expect(fixed.body.id).not.toBe(saved.body.id);
  });

  it("an invalid account or IFSC: failed with the bank's reason", async () => {
    await signedInCustomer();
    cashfree(200, { reference_id: 1, account_status: "INVALID", account_status_code: "INVALID_ACCOUNT_FAIL", name_at_bank: null, name_match_result: null, name_match_score: null });
    const saved = await saveMine();
    expect(saved.body).toMatchObject({ status: "FAILED", matchMethod: "BANK_CHECK", failureReason: "the bank says this account number is not valid", bankCheck: { result: "INVALID" } });

    cashfree(200, { reference_id: 2, account_status: "INVALID", account_status_code: "INVALID_IFSC_FAIL" });
    const ifsc = await saveMine({ ...BANK, ifsc: "SBIN0009999" });
    expect(ifsc.body.failureReason).toBe("the IFSC is not valid for this account");
  });

  it("Cashfree refuses (2FA) or cannot be reached: the account waits for the ₹1 check as before, and the holder can ask again", async () => {
    await signedInCustomer();
    cashfree(403, { code: "ip_validation_failed", message: "IP not whitelisted", type: "authentication_error" });
    const saved = await saveMine();
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ status: "PENDING", matchMethod: null, bankCheck: { result: "ERROR", verified: false } });
    const [check] = await checksOf(saved.body.id);
    expect(check).toMatchObject({ result: "ERROR", httpStatus: 403 });
    expect(check.errorMessage).toContain("ip_validation_failed");
    expect(check.errorMessage).toContain("CASHFREE_VERIFICATION_PUBLIC_KEY");
    // The holder never sees the technical text.
    expect(JSON.stringify(saved.body)).not.toContain("ip_validation_failed");

    // The ₹1 check is still offered.
    expect((await startRupee(saved.body.id)).status).toBe(201);

    // Asking the bank again once the 2FA is fixed.
    cashfree(200, VALID_MATCH);
    const again = await checkAgain(saved.body.id);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ status: "VERIFIED", matchMethod: "BANK_CHECK" });

    global.fetch = vi.fn(async () => {
      throw new Error("timeout");
    }) as typeof fetch;
    const other = await saveMine({ ...BANK, accountNumber: "123456789055", confirmAccountNumber: "123456789055" });
    expect(other.body).toMatchObject({ status: "PENDING", bankCheck: { result: "ERROR" } });
  });

  it("valid, with no word on the name: the ₹1 check decides", async () => {
    await signedInCustomer();
    cashfree(200, { reference_id: 9, account_status: "VALID", account_status_code: "ACCOUNT_IS_VALID" });
    const saved = await saveMine();
    expect(saved.body).toMatchObject({ status: "PENDING", matchMethod: null, bankCheck: { result: "VALID", verified: false } });
  });

  it("keys not set: recorded as not configured, nothing sent, the ₹1 check as before", async () => {
    await signedInCustomer();
    state.keys = null;
    cashfree(200, VALID_MATCH);
    const saved = await saveMine();
    expect(saved.body).toMatchObject({ status: "PENDING", bankCheck: { result: "NOT_CONFIGURED" } });
    expect(calls).toHaveLength(0);
    expect((await startRupee(saved.body.id)).status).toBe(201);
  });

  it("rule off, or a UPI ID: no check at all", async () => {
    await signedInCustomer();
    cashfree(200, VALID_MATCH);
    const upi = await saveMine({ method: "UPI", accountHolderName: "Ravi Kumar", upiId: "ravi.kumar@okicici" });
    expect(upi.body).toMatchObject({ status: "PENDING", bankCheck: null });

    await setRule("bankAccountCheck", { enabled: false }, admin);
    const off = await saveMine();
    expect(off.body).toMatchObject({ status: "PENDING", bankCheck: null });
    expect(calls).toHaveLength(0);
    expect(await db.select().from(bankAccountChecks)).toHaveLength(0);

    const retry = await checkAgain(off.body.id);
    expect(retry.status).toBe(409);
  });

  it("a daily limit per person (each check costs a fee)", async () => {
    await signedInCustomer();
    await setRule("bankAccountCheck", { enabled: true, maxChecksPerDay: 2 }, admin);
    cashfree(500, { message: "server error" });
    const first = await saveMine();
    expect(first.body.bankCheck.result).toBe("ERROR");
    expect((await checkAgain(first.body.id)).status).toBe(200);
    const third = await checkAgain(first.body.id);
    expect(third.status).toBe(429);
    expect(third.body.error.message).toContain("2 times a day");
    // Saving is never blocked by the limit: the account simply waits for ₹1.
    const another = await saveMine({ ...BANK, accountNumber: "123456789077", confirmAccountNumber: "123456789077" });
    expect(another.status).toBe(200);
    expect(another.body).toMatchObject({ status: "PENDING", bankCheck: null });
    expect(calls).toHaveLength(2);
  });

  it("someone else's account cannot be checked", async () => {
    await signedInCustomer();
    cashfree(500, {});
    const saved = await saveMine();
    const other = await createUser({ name: "Other" });
    signIn(other, "CUSTOMER");
    expect((await checkAgain(saved.body.id)).status).toBe(404);
  });

  it("a shop's payout account is checked the same way", async () => {
    const owner = await createUser({ role: "SHOP_OWNER", name: "Asha Patil" });
    const shop = await createShop(owner.id);
    signIn(owner, "SHOP_OWNER");
    cashfree(200, { ...VALID_MATCH, name_at_bank: "ASHA PATIL", name_match_result: "GOOD_PARTIAL_MATCH", name_match_score: "88.00" });
    const saved = await call(shopAccountPut, `/api/shops/${shop.id}/bank-account`, {
      method: "PUT",
      body: { ...BANK, accountHolderName: "Asha Patil" },
      params: { id: shop.id },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ status: "VERIFIED", matchMethod: "BANK_CHECK", matchedAccountHolderName: "ASHA PATIL" });
    const [row] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, saved.body.id));
    expect(row.shopId).toBe(shop.id);
  });
});

/* -------------------------------------------------------------- the rules */

describe("the decision and the keys", () => {
  const valid = { result: "VALID" as const, statusCode: "ACCOUNT_IS_VALID", nameAtBank: "RAVI KUMAR" };

  it("follows Cashfree's name match, then the score against the threshold", () => {
    expect(bankCheckDecision({ ...valid, nameMatchScore: 40, nameMatchResult: "GOOD_PARTIAL_MATCH" }, "Ravi Kumar", 80).verified).toBe(true);
    expect(bankCheckDecision({ ...valid, nameMatchScore: 95, nameMatchResult: "POOR_PARTIAL_MATCH" }, "Ravi Kumar", 80).verified).toBe(false);
    expect(bankCheckDecision({ ...valid, nameMatchScore: 85, nameMatchResult: "MODERATE_PARTIAL_MATCH" }, "Ravi Kumar", 80).verified).toBe(true);
    expect(bankCheckDecision({ ...valid, nameMatchScore: 70, nameMatchResult: "MODERATE_PARTIAL_MATCH" }, "Ravi Kumar", 80).verified).toBe(false);
    // Neither given: our own comparison with the bank's name.
    expect(bankCheckDecision({ ...valid, nameMatchScore: null, nameMatchResult: null }, "Ravi Kumar", 80)).toMatchObject({ decided: true, verified: true });
    expect(bankCheckDecision({ ...valid, nameAtBank: "SUNITA DESHMUKH", nameMatchScore: null, nameMatchResult: null }, "Ravi Kumar", 80)).toMatchObject({ decided: true, verified: false });
    expect(bankCheckDecision({ result: "ERROR", statusCode: null, nameAtBank: null, nameMatchScore: null, nameMatchResult: null }, "Ravi Kumar", 80).decided).toBe(false);
  });

  it("reads either key pair and the environment; never the values in what it reports", () => {
    const base = { CASHFREE_ENV: "sandbox" } as never;
    expect(bankCheckConfig(base)).toBeNull();
    const second = bankCheckConfig({ ...(base as object), CASHFREE_VERIFICATION_APP_ID: "id2", CASHFREE_VERIFICATION_SECRET_KEY: "s2" } as never);
    expect(second).toMatchObject({ clientId: "id2", env: "sandbox", foundAs: { clientId: "CASHFREE_VERIFICATION_APP_ID", clientSecret: "CASHFREE_VERIFICATION_SECRET_KEY" } });
    const prod = bankCheckConfig({ ...(base as object), ...KEYS, CASHFREE_VERIFICATION_ENV: "production" } as never);
    expect(prod?.env).toBe("production");
  });

  it("finds keys saved on the host under another name", () => {
    expect(findCashfreeVerificationKeys({ CASHFREE_APP_ID: "pg", CASHFREE_SECRET_KEY: "pg-secret" })).toBeNull();
    expect(findCashfreeVerificationKeys({ CASHFREE_CLIENT_ID: "a", CASHFREE_CLIENT_SECRET: "b" })).toMatchObject({ idName: "CASHFREE_CLIENT_ID", clientId: "a", clientSecret: "b" });
    expect(findCashfreeVerificationKeys({ CASHFREE_VERIFY_ID: "a", CASHFREE_VERIFY_SECRET: "b", CASHFREE_VERIFY_PUBLIC_KEY: "pem" })).toMatchObject({
      idName: "CASHFREE_VERIFY_ID",
      secretName: "CASHFREE_VERIFY_SECRET",
    });
    expect(findCashfreeVerificationKeys({ CF_SECUREID_CLIENT_ID: "a", CF_SECUREID_CLIENT_SECRET: "b" })?.idName).toBe("CF_SECUREID_CLIENT_ID");
    expect(findCashfreeVerificationKeys({ CASHFREE_VRS_APP_ID: "a" })).toBeNull(); // no secret
    expect(findCashfreeVerificationKeys({ CASHFREE_VERIFICATION_CLIENT_ID: "", CASHFREE_VERIFICATION_CLIENT_SECRET: "b" })).toBeNull();

    const found = bankCheckConfig({ CASHFREE_ENV: "sandbox" } as never, { idName: "CASHFREE_VERIFY_ID", secretName: "CASHFREE_VERIFY_SECRET", clientId: "a", clientSecret: "b" });
    expect(found).toMatchObject({ clientId: "a", env: "sandbox", foundAs: { clientId: "CASHFREE_VERIFY_ID", clientSecret: "CASHFREE_VERIFY_SECRET" } });
  });

  it("signs each call when the Secure ID public key is set (Cashfree's 2FA)", async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const now = Date.UTC(2026, 9, 9, 6, 0, 0);
    const signature = cashfreeSignature("CF-verify-id", pem, now);
    const plain = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(signature, "base64"));
    expect(plain.toString()).toBe(`CF-verify-id.${Math.floor(now / 1000)}`);

    // A PEM pasted with literal "\n"s still works, and the header is sent.
    state.keys = { ...KEYS, CASHFREE_VERIFICATION_PUBLIC_KEY: pem.replace(/\n/g, "\\n") };
    await signedInCustomer();
    cashfree(200, VALID_MATCH);
    await saveMine();
    const sent = calls[0].headers["x-cf-signature"];
    const decoded = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(sent, "base64"));
    expect(decoded.toString()).toMatch(/^CF-verify-id\.\d{10}$/);
  });
});

/* ---------------------------------------------------------------- finance */

describe("finance: status and connection test", () => {
  it("shows where the keys were found and the 2FA mode, without the values; tests with the sandbox sample account", async () => {
    signIn({ id: admin.id, email: "admin@example.com", name: "Admin" }, "ADMIN");
    const status = await call(adminStatusRoute, "/api/admin/bank-account-check");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      enabled: true,
      configured: true,
      env: "sandbox",
      foundAs: { clientId: "CASHFREE_VERIFICATION_CLIENT_ID", clientSecret: "CASHFREE_VERIFICATION_CLIENT_SECRET" },
      twoFactor: "IP_WHITELIST",
    });
    expect(JSON.stringify(status.body)).not.toContain("cf-verify-secret");

    cashfree(200, { ...VALID_MATCH, name_at_bank: "JOHN DOE", bank_name: "YES BANK" });
    const test = await call(adminTestRoute, "/api/admin/bank-account-check/test", { method: "POST" });
    expect(test.status, JSON.stringify(test.body)).toBe(200);
    expect(test.body).toMatchObject({ configured: true, env: "sandbox", outboundIp: "203.0.113.7", outcome: { result: "VALID", nameAtBank: "JOHN DOE" } });
    expect(calls[0].body).toEqual({ bank_account: "026291800001191", ifsc: "YESB0000262", name: "John Doe" });

    // Production keys: no test call with the sample account.
    state.keys = { ...KEYS, CASHFREE_VERIFICATION_ENV: "production" };
    expect((await call(adminTestRoute, "/api/admin/bank-account-check/test", { method: "POST" })).status).toBe(409);
  });

  it("customers and operators cannot see or test it", async () => {
    const customer = await createUser();
    signIn(customer, "CUSTOMER");
    expect((await call(adminStatusRoute, "/api/admin/bank-account-check")).status).toBe(403);
    expect((await call(adminTestRoute, "/api/admin/bank-account-check/test", { method: "POST" })).status).toBe(403);
  });
});
