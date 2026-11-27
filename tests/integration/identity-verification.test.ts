/**
 * One-time identity verification of customers and shop owners
 * (docs/identity-verification-2026-11). On the mock provider (the only one
 * off production): two switches, one per audience — each gates only its
 * own audience; off lifts the requirement at once; customer checkout blocked
 * until verified and never asked again; shop go-live blocked; existing shop
 * owners' grace period; name mismatch → review queue → admin approve;
 * admin-only page API; no full Aadhaar / PAN ever stored.
 */
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, getEnv: () => ({ ...actual.getEnv(), AUTH_URL: "https://test.gokesari.com" }) };
});

import { POST as decisionRoute } from "@/app/api/admin/identity-verifications/[id]/decision/route";
import { GET as adminListRoute } from "@/app/api/admin/identity-verifications/route";
import { POST as startRoute } from "@/app/api/account/identity/digilocker/route";
import { POST as panRoute } from "@/app/api/account/identity/pan/route";
import { GET as statusRoute } from "@/app/api/account/identity/route";
import { GET as returnRoute } from "@/app/mobile-auth/digilocker-return/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { auditLogs, featureFlags, identityVerificationPrompts, identityVerifications, shops, type FeatureFlagKey } from "@/server/db/schema";
import { clearMockDigilocker, decideMockDigilocker, MOCK_DIGILOCKER_LAST4, type MockDigilockerDecision } from "@/server/kyc/adapters/mock";
import { addToCart } from "@/server/services/cart";
import { clearFeatureFlagCache, setFeatureFlag } from "@/server/services/feature-flags";
import {
  assertShopIdentityAllowsOrders,
  getMyIdentityStatus,
  IDENTITY_FLAGS,
  identityStatusForUsers,
  noteSellerIdentityPrompt,
  sellerIdentityState,
  startIdentityDigilocker,
  verifyIdentityWithPan,
} from "@/server/services/identity-verification";
import { checkout, updateOrderStatus } from "@/server/services/orders";
import { approveShop } from "@/server/services/shops";
import { clearRuleCache } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createOrder, createShop, createStandardMilkSetup, createUser, deliveryAddressId, resetDatabase, verifySellerDocuments } from "../helpers/fixtures";

function signInAs(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

async function setFlag(key: FeatureFlagKey, enabled: boolean) {
  await db.insert(featureFlags).values({ key, enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
  clearFeatureFlagCache();
}

const sessionOf = (url: string) => new URL(url).searchParams.get("session")!;

/** Consent → DigiLocker (mock) → the person's decision → the shared return link. */
async function verifyByDigilocker(userId: string, decision: MockDigilockerDecision = "approve", holder?: string) {
  const started = await startIdentityDigilocker(userId, { consentGiven: true, ipAddress: "203.0.113.9", userAgent: "vitest" });
  expect(started.url).toBeTruthy();
  decideMockDigilocker(sessionOf(started.url!), decision, holder ?? `holder-${userId}`);
  const [row] = await db.select().from(identityVerifications).where(eq(identityVerifications.id, started.verification.id));
  const back = await returnRoute(new NextRequest(`https://0.0.0.0:3000/mobile-auth/digilocker-return?k=${encodeURIComponent(row.sessionReturnKey!)}`));
  return { back, row: (await db.select().from(identityVerifications).where(eq(identityVerifications.id, row.id)))[0] };
}

async function placeOrder(customerId: string, shopProductId: string, requestId: string) {
  await addToCart(customerId, shopProductId, 1);
  return checkout({ userId: customerId, addressId: await deliveryAddressId(customerId), requestId });
}

beforeEach(async () => {
  state.session = null;
  resetRateLimits();
  clearMockDigilocker();
  await resetDatabase();
  clearRuleCache();
  clearFeatureFlagCache();
});

describe("both switches off (seeded)", () => {
  it("nothing is asked or blocked, and the pages / APIs say not found", async () => {
    const { customer, shopProduct } = await createStandardMilkSetup();
    const placed = await placeOrder(customer.id, shopProduct.id, "idv-off-0001");
    expect(placed.orders).toHaveLength(1);
    signInAs(customer, "CUSTOMER");
    expect((await call(startRoute, "/api/account/identity/digilocker", { method: "POST", body: { consent: true } })).status).toBe(404);
    expect((await call(statusRoute, "/api/account/identity")).body.enabled).toBe(false);
  });
});

describe("customers switch", () => {
  it("blocks the first checkout until verified; never asked again; does not touch shop owners", async () => {
    await setFlag(IDENTITY_FLAGS.CUSTOMER, true);
    const { customer, owner, shopProduct } = await createStandardMilkSetup();

    await expect(placeOrder(customer.id, shopProduct.id, "idv-cust-0001")).rejects.toMatchObject({
      code: "CONFLICT",
      details: { needsIdentityVerification: true, verifyUrl: "/profile/verify-identity?next=/cart" },
    });

    // Consent is required; the checkbox is never pre-ticked.
    signInAs(customer, "CUSTOMER");
    expect((await call(startRoute, "/api/account/identity/digilocker", { method: "POST", body: { consent: false } })).status).toBe(422);

    const { back, row } = await verifyByDigilocker(customer.id);
    expect(back.headers.get("location")).toBe("https://test.gokesari.com/profile/verify-identity?digilocker=verified");
    expect(row).toMatchObject({ status: "VERIFIED", method: "AADHAAR_DIGILOCKER", maskedId: `XXXX XXXX ${MOCK_DIGILOCKER_LAST4}`, provider: "mock", subject: "CUSTOMER" });
    expect(row.consentVersion).toBeTruthy();
    expect(row.consentIp).toBe("203.0.113.9");
    expect(row.consentUserAgent).toBe("vitest");

    expect((await placeOrder(customer.id, shopProduct.id, "idv-cust-0002")).orders).toHaveLength(1);
    // Never asked again: a later order goes straight through, and starting again opens nothing.
    expect((await placeOrder(customer.id, shopProduct.id, "idv-cust-0003")).orders).toHaveLength(1);
    expect((await startIdentityDigilocker(customer.id, { consentGiven: true })).url).toBeNull();

    // The shop owners' switch is off: the unverified owner is not asked, no grace, orders accepted.
    expect(await sellerIdentityState(owner.id)).toMatchObject({ required: false });
    await expect(assertShopIdentityAllowsOrders((await db.select().from(shops))[0].id, { startGrace: true })).resolves.toBeUndefined();
  });

  it("switching it off lifts the requirement at once and keeps the stored verifications", async () => {
    await setFlag(IDENTITY_FLAGS.CUSTOMER, true);
    const { customer, shopProduct } = await createStandardMilkSetup();
    const other = await createUser({ name: "Asha Patil" });
    await verifyByDigilocker(other.id);
    await expect(placeOrder(customer.id, shopProduct.id, "idv-toggle-01")).rejects.toMatchObject({ code: "CONFLICT" });
    await setFlag(IDENTITY_FLAGS.CUSTOMER, false);
    expect((await placeOrder(customer.id, shopProduct.id, "idv-toggle-02")).orders).toHaveLength(1);
    const kept = await db.select().from(identityVerifications).where(eq(identityVerifications.userId, other.id));
    expect(kept.map((r) => r.status)).toEqual(["VERIFIED"]);
  });

  it("PAN instead of Aadhaar: only the last four characters are kept", async () => {
    await setFlag(IDENTITY_FLAGS.CUSTOMER, true);
    const customer = await createUser({ name: "Test User" });
    signInAs(customer, "CUSTOMER");
    // A business PAN is refused: identity is a person's own.
    expect((await call(panRoute, "/api/account/identity/pan", { method: "POST", body: { consent: true, pan: "ABCFE1234F" } })).status).toBe(422);
    const res = await call(panRoute, "/api/account/identity/pan", { method: "POST", body: { consent: true, pan: "ABCPE1234F" } });
    expect(res.status).toBe(200);
    expect(res.body.verification).toMatchObject({ status: "VERIFIED", method: "PAN", maskedId: "XXXXXX234F" });
    const [row] = await db.select().from(identityVerifications).where(eq(identityVerifications.userId, customer.id));
    expect(JSON.stringify(row)).not.toContain("ABCPE1234F");
  });
});

describe("shop owners switch", () => {
  it("a shop goes live only once its owner is verified; the customers switch being off leaves checkout alone", async () => {
    await setFlag(IDENTITY_FLAGS.SHOP_OWNER, true);
    const { customer, shopProduct } = await createStandardMilkSetup();
    expect((await placeOrder(customer.id, shopProduct.id, "idv-seller-01")).orders).toHaveLength(1);

    const owner = await createUser({ role: "SHOP_OWNER", name: "Owner" });
    const admin = await createUser({ role: "ADMIN" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", shopType: "HARDWARE_STORE" });
    await verifySellerDocuments(shop.id, ["PAN", "GSTIN", "SHOP_ACT"]);
    await db.update(shops).set({ feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));

    await expect(approveShop(shop.id, { classification: "GREEN" }, { id: admin.id, role: "ADMIN" })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { needsOwnerIdentityVerification: true },
    });
    const pan = await verifyIdentityWithPan(owner.id, { consentGiven: true, pan: "ABCPO1234K" });
    expect(pan.status).toBe("VERIFIED");
    expect((await approveShop(shop.id, { classification: "GREEN" }, { id: admin.id, role: "ADMIN" })).status).toBe("APPROVED");
  });

  it("existing shop: prompt at sign-in, grace period, then new order acceptance refused (accepted orders unaffected); off lifts it; back on restarts grace", async () => {
    await setFlag(IDENTITY_FLAGS.SHOP_OWNER, true);
    const { customer, owner, shop } = await createStandardMilkSetup();
    const ownerActor = { id: owner.id, role: "SHOP_OWNER" as const };

    const first = await noteSellerIdentityPrompt(owner.id);
    expect(first).toMatchObject({ required: true, graceOver: false });
    expect(first.graceEndsAt!.getTime() - first.firstPromptedAt!.getTime()).toBe(30 * 86_400_000);
    expect((await getMyIdentityStatus(owner.id)).seller.required).toBe(true);

    const inGrace = await createOrder(customer.id, shop.id, { status: "CONFIRMED" });
    expect((await updateOrderStatus(inGrace.id, "ACCEPTED", ownerActor)).status).toBe("ACCEPTED");

    // The grace period runs out.
    await db.update(identityVerificationPrompts).set({ firstPromptedAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(identityVerificationPrompts.userId, owner.id));
    const late = await createOrder(customer.id, shop.id, { status: "CONFIRMED" });
    await expect(updateOrderStatus(late.id, "ACCEPTED", ownerActor)).rejects.toMatchObject({ code: "CONFLICT" });
    // An order already accepted carries on.
    expect((await updateOrderStatus(inGrace.id, "PREPARING", ownerActor)).status).toBe("PREPARING");

    // Switched off: lifted at once.
    await setFlag(IDENTITY_FLAGS.SHOP_OWNER, false);
    expect(await sellerIdentityState(owner.id)).toMatchObject({ required: false, graceOver: false });
    expect((await updateOrderStatus(late.id, "ACCEPTED", ownerActor)).status).toBe("ACCEPTED");

    // Switched back on through the admin path (logged): the old prompt is ignored, grace starts again at the next prompt.
    const admin = await createUser({ role: "ADMIN" });
    await new Promise((r) => setTimeout(r, 5));
    await setFeatureFlag(IDENTITY_FLAGS.SHOP_OWNER, { enabled: true, districtCodes: null }, "Resume identity checks", { id: admin.id, role: "ADMIN" });
    expect(await sellerIdentityState(owner.id)).toMatchObject({ required: true, firstPromptedAt: null, graceOver: false });
    const again = await noteSellerIdentityPrompt(owner.id);
    expect(again.graceOver).toBe(false);
    expect(Date.now() - again.firstPromptedAt!.getTime()).toBeLessThan(60_000);

    // Verified: never asked again.
    await verifyByDigilocker(owner.id);
    expect(await sellerIdentityState(owner.id)).toMatchObject({ required: false, verified: true });
  });
});

describe("name mismatch → review queue → admin", () => {
  it("goes to review, appears in the admin queue, an admin approves with a note (audited); non-admins are refused", async () => {
    await setFlag(IDENTITY_FLAGS.CUSTOMER, true);
    const customer = await createUser({ name: "Ravi Kumar" });
    const { row } = await verifyByDigilocker(customer.id, "mismatch");
    expect(row).toMatchObject({ status: "NAME_MISMATCH_REVIEW", nameMatchResult: "MISMATCH", errorCode: "name_mismatch", comparedName: "Ravi Kumar" });

    signInAs(customer, "CUSTOMER");
    expect((await call(adminListRoute, "/api/admin/identity-verifications")).status).toBe(403);
    expect((await call(decisionRoute, `/api/admin/identity-verifications/${row.id}/decision`, { method: "POST", body: { decision: "APPROVE", note: "self" }, params: { id: row.id } })).status).toBe(403);

    const admin = await createUser({ role: "ADMIN" });
    signInAs(admin, "ADMIN");
    const list = await call(adminListRoute, "/api/admin/identity-verifications");
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([row.id]);

    const decided = await call(decisionRoute, `/api/admin/identity-verifications/${row.id}/decision`, {
      method: "POST",
      body: { decision: "APPROVE", note: "Name on Aadhaar is the married name; checked with the customer." },
      params: { id: row.id },
    });
    expect(decided.status).toBe(200);
    expect(decided.body.verification.status).toBe("VERIFIED");
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "identity.verification_decided"));
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(admin.id);
    expect((await identityStatusForUsers([customer.id])).get(customer.id)).toBe("VERIFIED");
  });

  it("the same DigiLocker account on a second account goes to review, not straight to Verified", async () => {
    await setFlag(IDENTITY_FLAGS.CUSTOMER, true);
    const a = await createUser({ name: "Test User" });
    const b = await createUser({ name: "Test User" });
    expect((await verifyByDigilocker(a.id, "approve", "same-holder")).row.status).toBe("VERIFIED");
    expect((await verifyByDigilocker(b.id, "approve", "same-holder")).row).toMatchObject({ status: "NAME_MISMATCH_REVIEW", errorCode: "duplicate_identity" });
  });
});

describe("guests and the data kept", () => {
  it("guests get 401 on every identity API", async () => {
    await setFlag(IDENTITY_FLAGS.CUSTOMER, true);
    expect((await call(statusRoute, "/api/account/identity")).status).toBe(401);
    expect((await call(startRoute, "/api/account/identity/digilocker", { method: "POST", body: { consent: true } })).status).toBe(401);
    expect((await call(panRoute, "/api/account/identity/pan", { method: "POST", body: { consent: true, pan: "ABCPE1234F" } })).status).toBe(401);
    expect((await call(adminListRoute, "/api/admin/identity-verifications")).status).toBe(401);
  });

  it("never stores a full Aadhaar or PAN; the database refuses a masked id with a number in it", async () => {
    await setFlag(IDENTITY_FLAGS.CUSTOMER, true);
    const one = await createUser({ name: "Test User" });
    const two = await createUser({ name: "Test User" });
    await verifyByDigilocker(one.id);
    await verifyIdentityWithPan(two.id, { consentGiven: true, pan: "ABCPE1234F" });
    const rows = await db.select().from(identityVerifications);
    for (const row of rows) {
      const { id: _id, userId: _u, idToken: _t, createdAt: _c, updatedAt: _up, consentAt: _ca, verifiedAt: _v, sessionExpiresAt: _s, ...text } = row;
      void [_id, _u, _t, _c, _up, _ca, _v, _s];
      // Generated uuids (e.g. in the mock providerRef) can end in 12 digits by chance: not an identity number.
      const flat = JSON.stringify(text).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
      expect(flat).not.toMatch(/\d{12}/);
      expect(flat).not.toMatch(/\d{4}\s\d{4}\s\d{4}/);
      expect(flat).not.toContain("ABCPE1234F");
      expect(row.maskedId).toMatch(/^(XXXX XXXX \d{4}|XXXXXX\d{3}[A-Z])$/);
    }
    await expect(
      db.insert(identityVerifications).values({
        userId: one.id,
        subject: "CUSTOMER",
        method: "PAN",
        status: "FAILED",
        maskedId: "2345 6789 0123",
        provider: "mock",
        consentAt: new Date(),
        consentVersion: "x",
      }),
    ).rejects.toThrow();
  });
});
