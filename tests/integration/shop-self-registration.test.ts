/**
 * Module 3 — shop self-registration with auto-approval
 * (docs/three-modules-2026-10). Real PostgreSQL; payments in mock mode, the
 * webhook called through its real route with a real HMAC signature; SMS and
 * WhatsApp in the mock outbox.
 *
 * The brief's cases: an invalid referral code is blocked before payment, a
 * failed payment leaves PENDING_PAYMENT with a retry, a duplicate (and
 * concurrent) webhook approves exactly once — plus an amount that is not the
 * fee, a forged signature, usage limits with held slots, the distributor's
 * commission, an existing account, the receipt and the owner's SMS sign-in.
 */
import { createHmac } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";

import { POST as otpRoute } from "@/app/api/shop-registrations/otp/route";
import { POST as webhookRoute } from "@/app/api/webhooks/cashfree/route";
import { db } from "@/server/db";
import {
  distributors,
  distributorTypes,
  domainEvents,
  outboundTestMessages,
  platformSettings,
  referralCodes,
  referralCommissions,
  referralRedemptions,
  registrationFeeTiers,
  registrationPayments,
  shopPayments,
  shopRegistrations,
  shops,
  shopWallets,
  userRoleGrants,
  users,
} from "@/server/db/schema";
import { requestLoginOtp, verifyLoginOtp } from "@/server/otp/service";
import { sendRegistrationOtp } from "@/server/registration/otp";
import {
  checkReferralCode,
  createRegistration,
  registrationReceiptPdf,
  registrationStatus,
  startRegistrationPayment,
} from "@/server/registration/service";
import { deliverPending } from "@/server/services/notifications";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createUser, resetDatabase, uniqueMobile } from "../helpers/fixtures";

let admin = { id: "", role: "ADMIN" as const };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(outboundTestMessages);
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["selfRegistration", "otp"]));
  clearRuleCache();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await setRule("selfRegistration", { enabled: true, holdHours: 24, maxPendingPerMobile: 3, classification: "GREEN" }, admin);
  await db.insert(registrationFeeTiers).values([
    { code: "BASIC", label: "Basic", amountPaise: 50_000, isActive: true, sortOrder: 1 },
    { code: "SILVER", label: "Silver", amountPaise: 0, isActive: false, sortOrder: 2 },
    { code: "GOLD", label: "Gold", amountPaise: 200_000, isActive: true, sortOrder: 3 },
  ]);
});

async function distributor(opts: { typeCommission?: ["FLAT" | "PERCENT", number]; own?: ["FLAT" | "PERCENT", number] } = {}) {
  const [type] = await db
    .insert(distributorTypes)
    .values({ code: `T${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name: "District distributor", commissionType: opts.typeCommission?.[0] ?? "PERCENT", commissionValue: opts.typeCommission?.[1] ?? 1000 })
    .returning();
  const [d] = await db
    .insert(distributors)
    .values({ distributorTypeId: type.id, name: "Pune Distributor", commissionType: opts.own?.[0] ?? null, commissionValue: opts.own?.[1] ?? null })
    .returning();
  return d;
}

async function code(value: string, opts: { distributorId?: string | null; maxUses?: number | null; status?: "ACTIVE" | "INACTIVE" | "EXPIRED"; expiresAt?: string | null } = {}) {
  const [row] = await db
    .insert(referralCodes)
    .values({ code: value, createdBy: admin.id, distributorId: opts.distributorId ?? null, maxUses: opts.maxUses ?? null, status: opts.status ?? "ACTIVE", expiresAt: opts.expiresAt ?? null })
    .returning();
  return row;
}

async function latestCode(mobileE164: string): Promise<string> {
  const rows = await db.select().from(outboundTestMessages).where(eq(outboundTestMessages.toAddress, mobileE164));
  const last = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return /(\d{4,8})/.exec(last.body)![1];
}

async function register(opts: { referral: string; tier?: string; shopName?: string; mobile?: string }) {
  const mobile = opts.mobile ?? uniqueMobile();
  await sendRegistrationOtp(`+91${mobile}`, null);
  const otp = await latestCode(`+91${mobile}`);
  const { token, registration } = await createRegistration(
    { shopName: opts.shopName ?? "Shree Ganesh Kirana", mobile, referralCode: opts.referral, tierCode: opts.tier ?? "BASIC", otp, acceptTerms: true },
    "127.0.0.1",
  );
  return { token, registration, mobile };
}

function webhook(body: unknown, opts: { badSignature?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Date.now());
  const secret = opts.badSignature ? "not-the-secret" : process.env.CASHFREE_SECRET_KEY!;
  const signature = createHmac("sha256", secret).update(timestamp + raw).digest("base64");
  return webhookRoute(
    new NextRequest("http://localhost/api/webhooks/cashfree", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", "x-webhook-signature": signature, "x-webhook-timestamp": timestamp },
    }),
  );
}

function paymentEvent(orderId: string, opts: { status?: string; rupees?: number; paymentId?: string; currency?: string } = {}) {
  const status = opts.status ?? "SUCCESS";
  return {
    type: status === "SUCCESS" ? "PAYMENT_SUCCESS_WEBHOOK" : status === "USER_DROPPED" ? "PAYMENT_USER_DROPPED_WEBHOOK" : "PAYMENT_FAILED_WEBHOOK",
    data: {
      order: { order_id: orderId, order_amount: opts.rupees ?? 500, order_currency: "INR" },
      payment: { cf_payment_id: opts.paymentId ?? `cf${Date.now()}`, payment_status: status, payment_amount: opts.rupees ?? 500, payment_currency: opts.currency ?? "INR" },
    },
  };
}

/* ========================================================== referral code */

describe("referral code is checked before anything else", () => {
  it("blocks unknown, inactive, expired and used-up codes — no OTP is sent, no registration saved", async () => {
    await code("INACTIVE1", { status: "INACTIVE" });
    await code("OLDCODE", { expiresAt: "2020-01-01" });
    await code("ONCEONLY", { maxUses: 1 });
    expect(await checkReferralCode("nope123")).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(await checkReferralCode("inactive1")).toMatchObject({ ok: false, reason: "INACTIVE" });
    expect(await checkReferralCode("OLDCODE")).toMatchObject({ ok: false, reason: "EXPIRED" });
    const ok = await checkReferralCode(" onceonly ");
    expect(ok).toMatchObject({ ok: true, code: "ONCEONLY" });
    if (ok.ok) expect(ok.tiers.map((t) => t.code)).toEqual(["BASIC", "GOLD"]); // inactive tiers are not offered

    // One pending registration holds the only slot.
    await register({ referral: "ONCEONLY" });
    expect(await checkReferralCode("ONCEONLY")).toMatchObject({ ok: false, reason: "LIMIT_REACHED" });

    const mobile = uniqueMobile();
    const res = await call(otpRoute as never, "/api/shop-registrations/otp", { method: "POST", body: { mobile, referralCode: "OLDCODE" } });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/expired/);
    expect(await db.select().from(outboundTestMessages).where(eq(outboundTestMessages.toAddress, `+91${mobile}`))).toHaveLength(0);
    expect(await db.select().from(shopRegistrations)).toHaveLength(1);
  });

  it("five registrations racing for a code's last slot: exactly one wins", async () => {
    await code("LASTSLOT", { maxUses: 1 });
    const applicants: { mobile: string; otp: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const mobile = uniqueMobile();
      await sendRegistrationOtp(`+91${mobile}`, null);
      applicants.push({ mobile, otp: await latestCode(`+91${mobile}`) });
    }
    const results = await Promise.allSettled(
      applicants.map((a) =>
        createRegistration({ shopName: "Race Shop", mobile: a.mobile, referralCode: "LASTSLOT", tierCode: "BASIC", otp: a.otp, acceptTerms: true }, "127.0.0.1"),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "VALIDATION_FAILED", details: { reason: "LIMIT_REACHED" } });
    }
    expect(await db.select().from(shopRegistrations)).toHaveLength(1);
  });

  it("the usage limit also holds for a code typed on the manual registration form", async () => {
    const { resolveUsableCode } = await import("@/server/services/referrals");
    await code("MANUAL1", { maxUses: 1 });
    await expect(resolveUsableCode("MANUAL1")).resolves.toMatchObject({ code: "MANUAL1" });
    await register({ referral: "MANUAL1" }); // holds the only place
    await expect(resolveUsableCode("manual1")).rejects.toThrow(/maximum number of times/);
  });

  it("needs the right OTP and an offered fee plan", async () => {
    await code("PUNE2026");
    const mobile = uniqueMobile();
    await sendRegistrationOtp(`+91${mobile}`, null);
    const otp = await latestCode(`+91${mobile}`);
    const wrong = otp === "000000" ? "111111" : "000000";
    await expect(createRegistration({ shopName: "A Shop", mobile, referralCode: "PUNE2026", tierCode: "BASIC", otp: wrong, acceptTerms: true }, null)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await sendRegistrationOtp(`+91${mobile}`, null).catch(() => undefined); // cooldown may refuse; the old code is still the latest
    const fresh = await latestCode(`+91${mobile}`);
    await expect(createRegistration({ shopName: "A Shop", mobile, referralCode: "PUNE2026", tierCode: "SILVER", otp: fresh, acceptTerms: true }, null)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

/* ========================================================== approval */

describe("payment webhook approves the shop in one transaction", () => {
  it("approves on a verified, exact payment: shop live, owner account, receipt, redemption, wallet, commission, messages", async () => {
    const d = await distributor({ typeCommission: ["PERCENT", 1000] });
    await code("DIST10", { distributorId: d.id });
    const { token, mobile } = await register({ referral: "DIST10", tier: "GOLD", shopName: "Sai Medical" });
    const pay = await startRegistrationPayment(token);
    expect(pay).toMatchObject({ gateway: "MOCK", amountPaise: 200_000 });

    // The browser coming back proves nothing: still pending until the webhook.
    expect((await registrationStatus(token)).status).toBe("PENDING_PAYMENT");

    const res = await webhook(paymentEvent(pay.orderId, { rupees: 2000, paymentId: "cf-777" }));
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("APPROVED");

    const [shop] = await db.select().from(shops);
    expect(shop).toMatchObject({ name: "Sai Medical", status: "APPROVED", lifecycleStatus: "ACTIVE", classification: "GREEN", onboardingChannel: "SELF_SERVICE", feePaymentStatus: "PAID", amountPaidPaise: 200_000, profileCompletedAt: null });
    const [owner] = await db.select().from(users).where(eq(users.id, shop.ownerId));
    expect(owner).toMatchObject({ phoneE164: `+91${mobile}`, emailPlaceholder: true, role: "SHOP_OWNER" });
    expect(owner.phoneVerifiedAt).not.toBeNull();
    expect(await db.select().from(userRoleGrants).where(eq(userRoleGrants.userId, owner.id))).toHaveLength(1);
    const [receipt] = await db.select().from(shopPayments).where(eq(shopPayments.shopId, shop.id));
    expect(receipt).toMatchObject({ paymentType: "REGISTRATION_FEE", method: "CASHFREE", amountPaise: 200_000, transactionId: "cf-777" });
    expect(await db.select().from(referralRedemptions).where(eq(referralRedemptions.shopId, shop.id))).toHaveLength(1);
    expect(await db.select().from(shopWallets).where(eq(shopWallets.shopId, shop.id))).toHaveLength(1);
    const [commission] = await db.select().from(referralCommissions);
    expect(commission).toMatchObject({ distributorId: d.id, commissionType: "PERCENT", commissionValue: 1000, basePaise: 200_000, amountPaise: 20_000, status: "ACCRUED" });
    expect(await db.select().from(domainEvents).where(eq(domainEvents.type, "shop.self_registered"))).toHaveLength(1);

    const status = await registrationStatus(token);
    expect(status).toMatchObject({ status: "APPROVED", shop: { registrationNumber: shop.registrationNumber }, receipt: receipt.reference });
    const pdf = (await registrationReceiptPdf(token)).body.toString("latin1");
    expect(pdf).toContain(receipt.reference);
    expect(pdf).toContain("Rs. 2,000.00");

    // Welcome by SMS and WhatsApp (mock); no email to the placeholder address.
    await deliverPending();
    const sent = await db.select().from(outboundTestMessages).where(and(eq(outboundTestMessages.toAddress, `+91${mobile}`), eq(outboundTestMessages.purpose, "notification")));
    expect(sent.map((m) => m.channel).sort()).toEqual(["SMS", "WHATSAPP"]);
    expect(sent[0].body).toContain(shop.registrationNumber);
  });

  it("uses the distributor's own commission over its type's default", async () => {
    const d = await distributor({ typeCommission: ["PERCENT", 1000], own: ["FLAT", 7_500] });
    await code("OWNRATE", { distributorId: d.id });
    const { token } = await register({ referral: "OWNRATE" });
    const pay = await startRegistrationPayment(token);
    await webhook(paymentEvent(pay.orderId));
    const [commission] = await db.select().from(referralCommissions);
    expect(commission).toMatchObject({ commissionType: "FLAT", amountPaise: 7_500 });
  });

  it("approves once for a duplicate and for concurrent webhooks", async () => {
    await code("DUPES");
    const { token } = await register({ referral: "DUPES" });
    const pay = await startRegistrationPayment(token);
    const event = paymentEvent(pay.orderId, { paymentId: "cf-same" });
    const results = await Promise.all([webhook(event), webhook(event), webhook(event)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const outcomes = await Promise.all(results.map(async (r) => (await r.json()).outcome));
    expect(outcomes.filter((o) => o === "APPROVED")).toHaveLength(1);
    // And again later.
    expect((await (await webhook(event)).json()).outcome).toBe("ALREADY_APPROVED");
    expect(await db.select().from(shops)).toHaveLength(1);
    expect(await db.select().from(shopPayments)).toHaveLength(1);
    expect(await db.select().from(referralRedemptions)).toHaveLength(1);
    expect(await db.select().from(domainEvents).where(eq(domainEvents.type, "shop.self_registered"))).toHaveLength(1);
  });

  it("never approves on an amount that is not the fee, or a forged signature", async () => {
    await code("MISMATCH");
    const { token } = await register({ referral: "MISMATCH" });
    const pay = await startRegistrationPayment(token);
    const forged = await webhook(paymentEvent(pay.orderId), { badSignature: true });
    expect(forged.status).toBe(400);
    const res = await webhook(paymentEvent(pay.orderId, { rupees: 5 }));
    expect((await res.json()).outcome).toBe("MISMATCH");
    expect(await db.select().from(shops)).toHaveLength(0);
    const [payment] = await db.select().from(registrationPayments).where(eq(registrationPayments.gatewayOrderId, pay.orderId));
    expect(payment.status).toBe("MISMATCH");
    expect(await db.select().from(domainEvents).where(eq(domainEvents.type, "registration.payment_mismatch"))).toHaveLength(1);
    expect((await registrationStatus(token)).status).toBe("PENDING_PAYMENT");
  });
});

/* ======================================================= failed payment */

describe("failed or dropped payment", () => {
  it("stays PENDING_PAYMENT with a retry; a later payment approves", async () => {
    await code("RETRY1");
    const { token, mobile } = await register({ referral: "RETRY1" });
    const first = await startRegistrationPayment(token);
    const failed = await webhook(paymentEvent(first.orderId, { status: "FAILED" }));
    expect((await failed.json()).outcome).toBe("FAILED");
    const status = await registrationStatus(token);
    expect(status).toMatchObject({ status: "PENDING_PAYMENT", lastPayment: { status: "FAILED" } });
    const sms = await db.select().from(outboundTestMessages).where(and(eq(outboundTestMessages.toAddress, `+91${mobile}`), eq(outboundTestMessages.purpose, "registration-retry")));
    expect(sms).toHaveLength(1);

    const second = await startRegistrationPayment(token);
    expect(second.orderId).not.toBe(first.orderId);
    expect((await (await webhook(paymentEvent(second.orderId))).json()).outcome).toBe("APPROVED");
    expect((await registrationStatus(token)).status).toBe("APPROVED");
  });

  it("a payment after cancellation, or a second payment after approval, is marked for a refund and support is told", async () => {
    const { cancelRegistration } = await import("@/server/registration/service");
    const { paymentProblems } = await import("@/server/registration/admin");
    await code("LATEPAY");
    const cancelled = await register({ referral: "LATEPAY" });
    const late = await startRegistrationPayment(cancelled.token);
    await cancelRegistration(cancelled.registration.id, admin);
    expect((await (await webhook(paymentEvent(late.orderId, { paymentId: "cf-late" }))).json()).outcome).toBe("IGNORED");
    expect(await db.select().from(shops)).toHaveLength(0);

    const twice = await register({ referral: "LATEPAY" });
    const first = await startRegistrationPayment(twice.token);
    const second = await startRegistrationPayment(twice.token);
    expect((await (await webhook(paymentEvent(first.orderId, { paymentId: "cf-first" }))).json()).outcome).toBe("APPROVED");
    expect((await (await webhook(paymentEvent(second.orderId, { paymentId: "cf-second" }))).json()).outcome).toBe("ALREADY_APPROVED");
    // A replay of the payment that approved it is not a problem.
    expect((await (await webhook(paymentEvent(first.orderId, { paymentId: "cf-first" }))).json()).outcome).toBe("ALREADY_APPROVED");

    const problems = await paymentProblems();
    expect(problems.map((p) => [p.payment.status, p.payment.failureReason]).sort()).toEqual([
      ["SUCCESS", "Paid after the registration was cancelled — refund due"],
      ["SUCCESS", "Paid again after approval — refund due"],
    ]);
    expect(await db.select().from(domainEvents).where(eq(domainEvents.type, "registration.payment_mismatch"))).toHaveLength(2);
    expect(await db.select().from(shops)).toHaveLength(1);
  });

  it("an unpaid registration's slot lapses after the hold; paying later needs room on the code", async () => {
    await code("ONESLOT", { maxUses: 1 });
    const a = await register({ referral: "ONESLOT" });
    await expect(register({ referral: "ONESLOT" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await db.update(shopRegistrations).set({ holdExpiresAt: new Date(Date.now() - 1000) }).where(eq(shopRegistrations.id, a.registration.id));
    const b = await register({ referral: "ONESLOT" });
    // A starting to pay now finds the slot taken.
    await expect(startRegistrationPayment(a.token)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const payB = await startRegistrationPayment(b.token);
    expect((await (await webhook(paymentEvent(payB.orderId))).json()).outcome).toBe("APPROVED");
  });
});

/* ============================================================ accounts */

describe("owner account", () => {
  it("uses the account that already has the mobile, and a mobile-only owner signs in with an SMS code", async () => {
    const mobile = uniqueMobile();
    const existing = await createUser({ role: "CUSTOMER", mobile });
    await code("EXIST");
    const { token } = await register({ referral: "EXIST", mobile });
    const pay = await startRegistrationPayment(token);
    await webhook(paymentEvent(pay.orderId));
    const [shop] = await db.select().from(shops);
    expect(shop.ownerId).toBe(existing.id);
    const [after] = await db.select().from(users).where(eq(users.id, existing.id));
    expect(after.role).toBe("SHOP_OWNER");
    expect(after.emailPlaceholder).toBe(false);

    // A new owner created from the mobile alone gets sign-in codes by SMS.
    const fresh = uniqueMobile();
    const reg = await register({ referral: "EXIST", mobile: fresh, shopName: "Fresh Mart" });
    const payFresh = await startRegistrationPayment(reg.token);
    await webhook(paymentEvent(payFresh.orderId));
    await db.update(platformSettings).set({ updatedAt: new Date() }).where(eq(platformSettings.key, "otp"));
    await requestLoginOtp({ mobile: fresh, ip: null });
    const signInCode = await latestCode(`+91${fresh}`);
    const { user } = await verifyLoginOtp({ mobile: fresh, code: signInCode, ip: null });
    expect(user.phoneE164).toBe(`+91${fresh}`);
    expect(user.role).toBe("SHOP_OWNER");
  });
});

/* ======================================================= profile + admin */

describe("after approval", () => {
  function gstinFor(state: string, pan: string): string {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const body = `${state}${pan}1Z`;
    let sum = 0;
    for (let i = 0; i < 14; i += 1) {
      const p = chars.indexOf(body[i]) * (i % 2 === 0 ? 1 : 2);
      sum += Math.floor(p / 36) + (p % 36);
    }
    return body + chars[(36 - (sum % 36)) % 36];
  }

  async function approvedShop() {
    await code("PROFILE1");
    const { token } = await register({ referral: "PROFILE1", shopName: "New Bakery" });
    const pay = await startRegistrationPayment(token);
    await webhook(paymentEvent(pay.orderId));
    const [shop] = await db.select().from(shops);
    const [owner] = await db.select().from(users).where(eq(users.id, shop.ownerId));
    return { shop, owner: { id: owner.id, role: owner.role } };
  }

  it("profile completion checks the GSTIN through the GSP, warns on a state mismatch, and completes with a category", async () => {
    const { profileSetupView, saveProfileSetup } = await import("@/server/registration/profile");
    const { createCategory } = await import("../helpers/fixtures");
    const { shopProductCategories } = await import("@/server/db/schema");
    const { shop, owner } = await approvedShop();
    expect(await profileSetupView(shop.id, owner)).toMatchObject({ missing: ["owner name", "address", "product categories"], fssai: { needed: false } });
    const base = { ownerName: "Ramesh Patil", addressLine1: "12 Market Road", city: "Pune", state: "Maharashtra", pincode: "411001", shopType: "BAKERY" as const };

    await expect(saveProfileSetup(shop.id, { ...base, gstin: "27ABCDE1234F1Z0".slice(0, 14) + "X" }, owner)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(saveProfileSetup(shop.id, { ...base, gstin: gstinFor("27", "ABCDE9999F") }, owner)).rejects.toThrow(/cancelled/);

    const result = await saveProfileSetup(shop.id, { ...base, gstin: gstinFor("29", "ABCDE1234F") }, owner);
    expect(result.gstin).toMatchObject({ ok: true, found: true, active: true });
    expect(result.warnings.join(" ")).toMatch(/Karnataka/);
    expect(result).toMatchObject({ complete: false, missing: ["product categories"] });
    const [saved] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(saved).toMatchObject({ ownerName: "Ramesh Patil", pincode: "411001", shopType: "BAKERY", gstStatus: "PENDING_VERIFICATION" });
    // A bakery sells food: reminded to add its FSSAI licence (remind only, nothing blocked).
    expect((await profileSetupView(shop.id, owner)).fssai).toEqual({ needed: true, onFile: false });

    const cat = await createCategory({ name: "Breads" });
    await db.insert(shopProductCategories).values({ shopId: shop.id, categoryId: cat.id });
    expect((await saveProfileSetup(shop.id, { ...base, gstin: gstinFor("29", "ABCDE1234F") }, owner)).complete).toBe(true);
    const [done] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(done.profileCompletedAt).not.toBeNull();

    const stranger = await createUser({ role: "SHOP_OWNER" });
    await expect(saveProfileSetup(shop.id, base, stranger)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("admin rules: an offered plan needs an amount, commission moves forward only, and the switch closes registration", async () => {
    const { updateTier, saveDistributor, saveDistributorType, setCommissionStatus } = await import("@/server/registration/admin");
    await expect(updateTier("SILVER", { label: "Silver", amountPaise: 0, isActive: true }, admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await updateTier("SILVER", { label: "Silver", amountPaise: 100_000, isActive: true }, admin)).toMatchObject({ isActive: true, amountPaise: 100_000 });
    const type = await saveDistributorType(null, { code: "CITY", name: "City distributor", commissionType: "PERCENT", commissionValue: 500, isActive: true }, admin);
    await expect(saveDistributorType(null, { code: "BAD", name: "Bad", commissionType: "PERCENT", commissionValue: 20_000, isActive: true }, admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(saveDistributor(null, { distributorTypeId: type.id, name: "Half set", commissionType: "FLAT", status: "ACTIVE" }, admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const d = await saveDistributor(null, { distributorTypeId: type.id, name: "City One", status: "ACTIVE" }, admin);
    await code("CITY1", { distributorId: d.id });
    const { token } = await register({ referral: "CITY1", tier: "SILVER" });
    await webhook(paymentEvent((await startRegistrationPayment(token)).orderId, { rupees: 1000 }));
    const [commission] = await db.select().from(referralCommissions);
    expect(commission).toMatchObject({ commissionType: "PERCENT", amountPaise: 5_000 });
    await expect(setCommissionStatus(commission.id, "PAID", null, admin)).rejects.toMatchObject({ code: "CONFLICT" });
    await setCommissionStatus(commission.id, "APPROVED", null, admin);
    expect(await setCommissionStatus(commission.id, "PAID", "UTR123", admin)).toMatchObject({ status: "PAID", note: "UTR123" });

    await setRule("selfRegistration", { enabled: false, holdHours: 24, maxPendingPerMobile: 3, classification: "GREEN" }, admin);
    clearRuleCache();
    const res = await call(otpRoute as never, "/api/shop-registrations/otp", { method: "POST", body: { mobile: uniqueMobile(), referralCode: "CITY1" } });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/not open/);
  });
});
