/**
 * batch-2026-10 WS-D — F8.4.2 Operator-Limited shop onboarding (RBAC-003).
 * Route-level where it matters (auth, 403s); payment intents are mocked (WS-A owns them).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
  outbox: [] as { to: string; subject: string; text: string }[],
  intents: new Map<string, { id: string; status: string; referenceId: string; amountPaise: number; userId: string | null; mode: string }>(),
  created: [] as unknown[],
}));

vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));
vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    state.outbox.push(message);
  },
  EmailUnavailableError: class extends Error {},
}));
vi.mock("@/server/payments/intents", () => ({
  PAYMENT_INTENT_STATUSES: ["CREATED", "PENDING", "AUTHORIZED", "CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED", "FAILED", "EXPIRED"],
  createPaymentIntent: async (input: { purpose: string; referenceId: string; userId: string | null; amountPaise: number; idempotencyKey: string; mode: string }) => {
    state.created.push(input);
    const id = `pi_${input.idempotencyKey.replace(/[^a-z0-9]/gi, "").slice(-24)}`;
    const existing = state.intents.get(id);
    const intent = existing ?? { id, status: "PENDING", referenceId: input.referenceId, amountPaise: input.amountPaise, userId: input.userId, mode: input.mode };
    state.intents.set(id, intent);
    const ref = { ...intent, purpose: input.purpose, refundedPaise: 0, gateway: "SANDBOX", gatewayOrderId: `go_${id}`, gatewayPaymentId: null };
    return input.mode === "LINK"
      ? { intent: ref, checkout: null, linkUrl: `https://pay.example.test/l/${id}` }
      : { intent: ref, checkout: { kind: "HOSTED_URL", url: `https://pay.example.test/c/${id}` }, linkUrl: null };
  },
  getPaymentIntent: async (id: string) => {
    const i = state.intents.get(id);
    return i ? { ...i, purpose: "SHOP_REGISTRATION_FEE", refundedPaise: 0, gateway: "SANDBOX", gatewayOrderId: `go_${id}`, gatewayPaymentId: null } : null;
  },
  findCapturedIntent: async () => null,
  refundPaymentIntent: async () => {
    throw new Error("not used");
  },
}));

import { POST as onboardingPost } from "@/app/api/operator/onboarding/route";
import { POST as verifyPost } from "@/app/api/operator/onboarding/[id]/verify/route";
import { POST as shopPost } from "@/app/api/operator/onboarding/[id]/shop/route";
import { POST as feePost } from "@/app/api/operator/onboarding/[id]/fee/route";
import { GET as shopsGet } from "@/app/api/operator/shops/route";
import { GET as docsGet } from "@/app/api/operator/shops/[shopId]/documents/route";
import { POST as decidePost } from "@/app/api/operator/documents/[verificationId]/route";
import { GET as financeSettlementsGet } from "@/app/api/finance/settlements/route";
import { GET as riderPayoutsGet } from "@/app/api/finance/rider-payouts/route";
import { GET as settingsGet } from "@/app/api/admin/settings/route";
import { PATCH as shopPatch } from "@/app/api/shops/[id]/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { can, PERMISSIONS, ROLE_PERMISSIONS } from "@/server/authz/permissions";
import { docBlindIndex, encryptSecret } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import { auditLogs, notifications, sellerVerifications, shopCategories, shopOnboardingSessions, shopPayments, shops, users } from "@/server/db/schema";
import { CAPTURED_HANDLERS } from "@/server/payments/purpose-handlers";
import { AUDIT_ACTIONS } from "@/server/services/audit";
import { finishFeeCapture, sweepOnboardingFees } from "@/server/services/operator-limited";
import { setRegistrationFee } from "@/server/services/registration-fees";
import { setRule } from "@/server/services/settings";
import { updateUserPrivileges } from "@/server/services/users";
import { call } from "../helpers/http";
import { createUser, resetDatabase, verifySellerDocuments } from "../helpers/fixtures";

function signIn(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

function lastCodeTo(email: string): string {
  const message = [...state.outbox].reverse().find((m) => m.to === email);
  const code = message?.subject.match(/^(\d{4,8}) /)?.[1];
  if (!code) throw new Error(`no code was emailed to ${email}`);
  return code;
}

let categoryId: string;
let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter += 1)}`;

async function auditCount(action: string, actorId?: string) {
  const rows = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(actorId ? and(eq(auditLogs.action, action), eq(auditLogs.actorId, actorId)) : eq(auditLogs.action, action));
  return rows.length;
}

const shopBody = (over: Record<string, unknown> = {}) => ({
  name: `Onboarded Dairy ${uniq()}`,
  ownerName: "Sunita Patil",
  phone: "9876543210",
  addressLine1: "12 Market Road",
  city: "Pune",
  pincode: "411001",
  shopType: "DAIRY",
  categoryIds: [categoryId],
  shopActNumber: `SA${uniq().toUpperCase()}`,
  ...over,
});

/** Operator sends the code, owner reads it back, operator registers the shop. */
async function onboard(operator: { id: string; email: string; name: string | null; role: UserRole }, ownerEmail: string) {
  signIn(operator);
  const start = await call(onboardingPost, "/api/operator/onboarding", { method: "POST", body: { ownerEmail } });
  expect(start.status).toBe(201);
  const sessionId = start.body.sessionId as string;
  const verified = await call(verifyPost, `/api/operator/onboarding/${sessionId}/verify`, { method: "POST", body: { code: lastCodeTo(ownerEmail) }, params: { id: sessionId } });
  expect(verified.status).toBe(200);
  const shop = await call(shopPost, `/api/operator/onboarding/${sessionId}/shop`, { method: "POST", body: shopBody(), params: { id: sessionId } });
  expect(shop.status).toBe(201);
  return { sessionId, shopId: shop.body.shop.id as string, ownerUserId: verified.body.ownerUserId as string };
}

async function operatorLimited(name = "Ravi Operator") {
  const u = await createUser({ role: "OPERATOR_LIMITED", name, email: `oplim-${uniq()}@test.local` });
  return { id: u.id, email: u.email, name: u.name, role: "OPERATOR_LIMITED" as const };
}

beforeEach(async () => {
  state.session = null;
  state.outbox = [];
  state.intents.clear();
  state.created = [];
  resetRateLimits();
  await resetDatabase();
  await db.execute(sql`TRUNCATE TABLE shop_onboarding_sessions`);
  const [cat] = await db.insert(shopCategories).values({ name: `Dairy WSD ${uniq()}`, slug: `dairy-wsd-${uniq()}` }).returning();
  categoryId = cat.id;
  // The registration fee in force (₹5,000), as an admin sets it. Shops are
  // charged it plus 18% GST: ₹5,900 (owner, 27 Oct 2026).
  const feeAdmin = await createUser({ role: "ADMIN", email: `fee-admin-${uniq()}@test.local` });
  await setRegistrationFee({ amountPaise: 500_000 }, { id: feeAdmin.id, role: "ADMIN" });
});

afterAll(async () => {
  await resetDatabase();
  await db.delete(shopCategories).where(sql`${shopCategories.name} LIKE 'Dairy WSD %'`);
});

describe("Operator-Limited role (F8.4.2)", () => {
  it("TC-B26-D-001 has exactly onboarding + document verification, and no finance, payouts, settings or other-shop powers", () => {
    expect(can("OPERATOR_LIMITED", PERMISSIONS.OPERATOR_LIMITED_ONBOARD)).toBe(true);
    expect(can("OPERATOR_LIMITED", PERMISSIONS.OPERATOR_LIMITED_VERIFY_DOCS)).toBe(true);
    for (const p of [
      PERMISSIONS.FINANCE_VIEW, PERMISSIONS.FINANCE_MANAGE, PERMISSIONS.FINANCE_PREPARE, PERMISSIONS.FINANCE_EXCEPTIONS_VIEW,
      PERMISSIONS.PAYMENT_VIEW_ANY, PERMISSIONS.PAYMENT_RECORD, PERMISSIONS.SYSTEM_CONFIG, PERMISSIONS.SHOP_UPDATE_ANY,
      PERMISSIONS.SHOP_APPROVE, PERMISSIONS.SHOP_REGISTRATION_MANAGE, PERMISSIONS.SHOP_GST_PAN_VERIFY, PERMISSIONS.USER_VIEW_ANY,
      PERMISSIONS.REGISTRATION_FEE_MANAGE, PERMISSIONS.AUDIT_LOG_VIEW, PERMISSIONS.AUDIT_LOG_VIEW_LIMITED,
    ]) {
      expect(can("OPERATOR_LIMITED", p)).toBe(false);
    }
    expect(ROLE_PERMISSIONS.OPERATOR_LIMITED.every((p) => ROLE_PERMISSIONS.ADMIN.includes(p))).toBe(true);
    expect(can("OPERATOR", PERMISSIONS.OPERATOR_LIMITED_ONBOARD)).toBe(false);
  });

  it("TC-B26-D-002 an admin grants the role through the existing privileges save, and the user can act as it", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const target = await createUser({ email: `grant-${uniq()}@test.local` });
    await updateUserPrivileges(target.id, { activeRole: "OPERATOR_LIMITED", heldRoles: ["CUSTOMER", "OPERATOR_LIMITED"] }, { id: admin.id, role: "ADMIN" });
    const [after] = await db.select({ role: users.role }).from(users).where(eq(users.id, target.id));
    expect(after.role).toBe("OPERATOR_LIMITED");
  });

  it("TC-B26-D-003 cannot register a shop before the owner's code is entered", async () => {
    const op = await operatorLimited();
    signIn(op);
    const start = await call(onboardingPost, "/api/operator/onboarding", { method: "POST", body: { ownerEmail: "owner-a@example.com" } });
    const sessionId = start.body.sessionId as string;
    const res = await call(shopPost, `/api/operator/onboarding/${sessionId}/shop`, { method: "POST", body: shopBody(), params: { id: sessionId } });
    expect(res.status).toBe(403);
    expect(await db.$count(shops)).toBe(0);
  });

  it("TC-B26-D-004 a wrong code is refused (and audited); the code is bound to the operator who asked", async () => {
    const op = await operatorLimited();
    const other = await operatorLimited("Other Operator");
    signIn(op);
    const start = await call(onboardingPost, "/api/operator/onboarding", { method: "POST", body: { ownerEmail: "owner-b@example.com" } });
    const sessionId = start.body.sessionId as string;
    const real = lastCodeTo("owner-b@example.com");
    const wrong = real === "000000" ? "111111" : "000000";
    const bad = await call(verifyPost, `/api/operator/onboarding/${sessionId}/verify`, { method: "POST", body: { code: wrong }, params: { id: sessionId } });
    expect(bad.status).toBe(422);
    expect(await auditCount(AUDIT_ACTIONS.OPLTD_OWNER_OTP_FAILED, op.id)).toBe(1);
    // Another operator cannot use (or even see) this onboarding.
    signIn(other);
    const theirs = await call(verifyPost, `/api/operator/onboarding/${sessionId}/verify`, { method: "POST", body: { code: real }, params: { id: sessionId } });
    expect(theirs.status).toBe(404);
    const [s] = await db.select().from(shopOnboardingSessions).where(eq(shopOnboardingSessions.id, sessionId));
    expect(s.status).toBe("OTP_SENT");
  });

  it("TC-B26-D-005 with the owner's code the shop is registered under the owner, onboarded_by recorded, owner notified, audited", async () => {
    const op = await operatorLimited();
    const { shopId, ownerUserId } = await onboard(op, "owner-c@example.com");
    const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
    expect(shop.ownerId).toBe(ownerUserId);
    expect(shop.onboardedByUserId).toBe(op.id);
    expect(shop.status).toBe("PENDING_APPROVAL");
    const [owner] = await db.select().from(users).where(eq(users.id, ownerUserId));
    expect(owner.email).toBe("owner-c@example.com");
    expect(owner.emailVerified).not.toBeNull();
    const ownerNotes = await db.select().from(notifications).where(and(eq(notifications.userId, ownerUserId), eq(notifications.type, "shop.onboarded_by_operator")));
    expect(ownerNotes).toHaveLength(1);
    expect(await auditCount(AUDIT_ACTIONS.OPLTD_OWNER_OTP_SENT, op.id)).toBe(1);
    expect(await auditCount(AUDIT_ACTIONS.OPLTD_OWNER_VERIFIED, op.id)).toBe(1);
    expect(await auditCount(AUDIT_ACTIONS.OPLTD_SHOP_SUBMITTED, op.id)).toBe(1);
  });

  it("TC-B26-D-006 sees only the shops they onboarded; another operator's shop and its documents are refused", async () => {
    const a = await operatorLimited("A");
    const b = await operatorLimited("B");
    const { shopId } = await onboard(a, "owner-d@example.com");
    signIn(b);
    const list = await call(shopsGet, "/api/operator/shops");
    expect(list.status).toBe(200);
    expect(list.body.shops).toHaveLength(0);
    const docs = await call(docsGet, `/api/operator/shops/${shopId}/documents`, { params: { shopId } });
    expect(docs.status).toBe(404);
    expect(await auditCount(AUDIT_ACTIONS.OPLTD_ACCESS_DENIED, b.id)).toBe(1);
    signIn(a);
    const mine = await call(shopsGet, "/api/operator/shops");
    expect(mine.body.shops.map((s: { shopId: string }) => s.shopId)).toEqual([shopId]);
    // Editing any shop through the general shop API is not theirs either.
    const patch = await call(shopPatch, `/api/shops/${shopId}`, { method: "PATCH", body: { description: "x" }, params: { id: shopId } });
    expect(patch.status).toBe(403);
  });

  it("TC-B26-D-007 views the documents by shop type and approves / rejects with a reason (own shop only)", async () => {
    const a = await operatorLimited("A");
    const b = await operatorLimited("B");
    const { shopId } = await onboard(a, "owner-e@example.com");
    const [fssai] = await db
      .insert(sellerVerifications)
      .values({ shopId, docType: "FSSAI", status: "MANUAL_REVIEW", numberEncrypted: encryptSecret("12345678901234"), numberMasked: "XXXXXXXXXX1234", numberHash: docBlindIndex("FSSAI", "12345678901234"), consentGivenAt: new Date(), consentVersion: "v1" })
      .returning();
    const [pan] = await db
      .insert(sellerVerifications)
      .values({ shopId, docType: "PAN", status: "MANUAL_REVIEW", numberEncrypted: encryptSecret("ABCPE1234F"), numberMasked: "XXXXX1234F", numberHash: docBlindIndex("PAN", "ABCPE1234F"), consentGivenAt: new Date(), consentVersion: "v1" })
      .returning();
    signIn(a);
    const docs = await call(docsGet, `/api/operator/shops/${shopId}/documents`, { params: { shopId } });
    expect(docs.status).toBe(200);
    const fssaiDoc = docs.body.documents.find((d: { docType: string }) => d.docType === "FSSAI");
    expect(fssaiDoc.requirement).not.toBe("optional"); // a dairy is a food business
    expect(docs.body.isFoodBusiness).toBe(true);

    const noReason = await call(decidePost, `/api/operator/documents/${pan.id}`, { method: "POST", body: { decision: "reject", reason: "" }, params: { verificationId: pan.id } });
    expect(noReason.status).toBe(422);
    const approved = await call(decidePost, `/api/operator/documents/${fssai.id}`, { method: "POST", body: { decision: "approve", reason: "Matches the licence" }, params: { verificationId: fssai.id } });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("VERIFIED");
    const rejected = await call(decidePost, `/api/operator/documents/${pan.id}`, { method: "POST", body: { decision: "reject", reason: "Name does not match the owner" }, params: { verificationId: pan.id } });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("FAILED");
    expect(rejected.body.reviewNote).toBe("Name does not match the owner");

    signIn(b);
    const theirs = await call(decidePost, `/api/operator/documents/${pan.id}`, { method: "POST", body: { decision: "approve", reason: "ok" }, params: { verificationId: pan.id } });
    expect(theirs.status).toBe(404);
    expect(await auditCount(AUDIT_ACTIONS.OPLTD_DOCUMENT_DECIDED, a.id)).toBe(2);
    expect(await auditCount(AUDIT_ACTIONS.OPLTD_DOCUMENTS_VIEWED, a.id)).toBe(1);
  });

  it("TC-B26-D-008 finance, payout and platform-settings routes answer 403", async () => {
    const op = await operatorLimited();
    signIn(op);
    expect((await call(financeSettlementsGet, "/api/finance/settlements")).status).toBe(403);
    expect((await call(riderPayoutsGet, "/api/finance/rider-payouts")).status).toBe(403);
    expect((await call(settingsGet, "/api/admin/settings")).status).toBe(403);
  });

  it("TC-B26-D-009 fee by payment link: intent created for the owner, link emailed, request reused on a double press, audited", async () => {
    const op = await operatorLimited();
    const { sessionId, ownerUserId, shopId } = await onboard(op, "owner-f@example.com");
    const fee = await call(feePost, `/api/operator/onboarding/${sessionId}/fee`, { method: "POST", body: { mode: "LINK" }, params: { id: sessionId } });
    expect(fee.status).toBe(201);
    expect(fee.body.linkUrl).toMatch(/^https:\/\/pay\.example\.test\/l\//);
    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({ purpose: "SHOP_REGISTRATION_FEE", referenceId: shopId, userId: ownerUserId, mode: "LINK", amountPaise: 590000 });
    const again = await call(feePost, `/api/operator/onboarding/${sessionId}/fee`, { method: "POST", body: { mode: "LINK" }, params: { id: sessionId } });
    expect(again.body.linkUrl).toBe(fee.body.linkUrl);
    expect(state.created).toHaveLength(1);
    const linkNotes = await db.select().from(notifications).where(and(eq(notifications.userId, ownerUserId), eq(notifications.type, "shop.registration_fee_link")));
    expect(linkNotes).toHaveLength(1);
    expect(await auditCount(AUDIT_ACTIONS.OPLTD_FEE_REQUESTED, op.id)).toBe(1);
  });

  it("TC-B26-D-010 capture → fee recorded ONLINE in the capture transaction → existing auto-approve rule approves; a replay records nothing twice", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await setRule("sellerVerification", { autoApproveShop: true }, { id: admin.id, role: "ADMIN" });
    const op = await operatorLimited();
    const { sessionId, shopId, ownerUserId } = await onboard(op, "owner-g@example.com");
    await verifySellerDocuments(shopId);
    signIn(op);
    const fee = await call(feePost, `/api/operator/onboarding/${sessionId}/fee`, { method: "POST", body: { mode: "CHECKOUT" }, params: { id: sessionId } });
    expect(fee.body.checkoutUrl).toMatch(/\/c\//);
    const intentId = [...state.intents.keys()][0];
    const intent = { id: intentId, purpose: "SHOP_REGISTRATION_FEE" as const, referenceId: shopId, userId: ownerUserId, amountPaise: 590000, refundedPaise: 0, status: "CAPTURED" as const, gateway: "SANDBOX" as const, gatewayOrderId: "go_1", gatewayPaymentId: "pay_1" };
    const handler = CAPTURED_HANDLERS.SHOP_REGISTRATION_FEE!;
    await db.transaction(async (tx) => handler(intent, tx));
    await db.transaction(async (tx) => handler(intent, tx)); // replayed webhook
    const payments = await db.select().from(shopPayments).where(eq(shopPayments.shopId, shopId));
    expect(payments).toHaveLength(1);
    expect(payments[0].method).toBe("ONLINE");
    const r = await finishFeeCapture(shopId, intentId);
    expect(r.approved).toBe(true);
    const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
    expect(shop.status).toBe("APPROVED");
    expect(shop.feePaymentStatus).toBe("PAID");
    const [session] = await db.select().from(shopOnboardingSessions).where(eq(shopOnboardingSessions.id, sessionId));
    expect(session.status).toBe("COMPLETED");
    expect(await auditCount(AUDIT_ACTIONS.OPLTD_FEE_PAID)).toBe(1);
  });

  it("TC-B26-D-011 with the auto-approve rule off, a paid fee leaves the shop pending for an admin", async () => {
    const op = await operatorLimited();
    const { sessionId, shopId, ownerUserId } = await onboard(op, "owner-h@example.com");
    await verifySellerDocuments(shopId);
    signIn(op);
    await call(feePost, `/api/operator/onboarding/${sessionId}/fee`, { method: "POST", body: { mode: "LINK" }, params: { id: sessionId } });
    const intentId = [...state.intents.keys()][0];
    await db.transaction((tx) =>
      CAPTURED_HANDLERS.SHOP_REGISTRATION_FEE!({ id: intentId, purpose: "SHOP_REGISTRATION_FEE", referenceId: shopId, userId: ownerUserId, amountPaise: 590000, refundedPaise: 0, status: "CAPTURED", gateway: "SANDBOX", gatewayOrderId: null, gatewayPaymentId: "pay_2" }, tx),
    );
    expect((await finishFeeCapture(shopId, intentId)).approved).toBe(false);
    const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
    expect(shop.status).toBe("PENDING_APPROVAL");
    expect(shop.feePaymentStatus).toBe("PAID");
  });

  it("TC-B26-D-012 a failed payment sends the shop to pending admin approval and tells the admins and the operator", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const op = await operatorLimited();
    const { sessionId, shopId } = await onboard(op, "owner-i@example.com");
    signIn(op);
    await call(feePost, `/api/operator/onboarding/${sessionId}/fee`, { method: "POST", body: { mode: "LINK" }, params: { id: sessionId } });
    const intentId = [...state.intents.keys()][0];
    state.intents.get(intentId)!.status = "FAILED";
    const swept = await sweepOnboardingFees();
    expect(swept.failed).toBe(1);
    expect((await sweepOnboardingFees()).failed).toBe(0); // idempotent
    const [session] = await db.select().from(shopOnboardingSessions).where(eq(shopOnboardingSessions.id, sessionId));
    expect(session).toMatchObject({ status: "PENDING_ADMIN", feeStatus: "FAILED" });
    const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
    expect(shop.status).toBe("PENDING_APPROVAL");
    const adminNotes = await db.select().from(notifications).where(and(eq(notifications.userId, admin.id), eq(notifications.type, "support.shop_registration_fee_failed")));
    expect(adminNotes).toHaveLength(1);
    const opNotes = await db.select().from(notifications).where(and(eq(notifications.userId, op.id), eq(notifications.type, "shop.registration_fee_failed")));
    expect(opNotes).toHaveLength(1);
    expect(await auditCount(AUDIT_ACTIONS.OPLTD_FEE_FAILED)).toBe(1);
  });

  it("TC-B26-D-013 an unpaid link that expires also goes to pending admin approval", async () => {
    const op = await operatorLimited();
    const { sessionId } = await onboard(op, "owner-j@example.com");
    signIn(op);
    await call(feePost, `/api/operator/onboarding/${sessionId}/fee`, { method: "POST", body: { mode: "LINK" }, params: { id: sessionId } });
    const later = new Date(Date.now() + 80 * 3_600_000);
    const swept = await sweepOnboardingFees({ now: later });
    expect(swept.expired).toBe(1);
    const [session] = await db.select().from(shopOnboardingSessions).where(eq(shopOnboardingSessions.id, sessionId));
    expect(session).toMatchObject({ status: "PENDING_ADMIN", feeStatus: "EXPIRED" });
  });

  it("TC-B26-D-014 every onboarding action leaves an audit row with the Operator-Limited role", async () => {
    const op = await operatorLimited();
    const { sessionId } = await onboard(op, "owner-k@example.com");
    signIn(op);
    await call(feePost, `/api/operator/onboarding/${sessionId}/fee`, { method: "POST", body: { mode: "LINK" }, params: { id: sessionId } });
    await call(shopsGet, "/api/operator/shops");
    const rows = await db
      .select({ action: auditLogs.action, role: auditLogs.actorRole })
      .from(auditLogs)
      .where(and(eq(auditLogs.actorId, op.id), inArray(auditLogs.action, Object.values(AUDIT_ACTIONS).filter((a) => a.startsWith("operator_limited.")))));
    expect(new Set(rows.map((r) => r.action))).toEqual(
      new Set([
        AUDIT_ACTIONS.OPLTD_OWNER_OTP_SENT,
        AUDIT_ACTIONS.OPLTD_OWNER_VERIFIED,
        AUDIT_ACTIONS.OPLTD_SHOP_SUBMITTED,
        AUDIT_ACTIONS.OPLTD_FEE_REQUESTED,
        AUDIT_ACTIONS.OPLTD_SHOPS_VIEWED,
      ]),
    );
    expect(rows.every((r) => r.role === "OPERATOR_LIMITED")).toBe(true);
  });
});
