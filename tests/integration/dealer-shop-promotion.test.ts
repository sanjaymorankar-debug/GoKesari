/**
 * A shop owner promoted to dealer / franchisee (owner, 28-Nov-2026; src/server/dealers/promotion.ts), against real
 * PostgreSQL:
 *   - one account, nothing typed again: the free franchisee request, the full application (/dealer/apply) and the paid
 *     franchise start take name, PAN / GSTIN, address, mobile, e-mail and the verified payout bank from the live shop,
 *     and what the shop verified counts as verified (no second online check);
 *   - four-eye: the admin's Approve only records a pending decision; the same admin cannot confirm it; a DIFFERENT
 *     admin or an operator confirms → GKD code, DEALER role, role history, e-mail; a rejection leaves it pending;
 *   - a paid franchise is not a promotion (no approval request), and an applicant without a live shop is approved
 *     by one admin as before.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as decisionPost } from "@/app/api/admin/dealers/[id]/decision/route";
import { POST as decidePost } from "@/app/api/approvals/[id]/decide/route";
import { PUT as appPut } from "@/app/api/dealer/application/route";
import { POST as submitPost } from "@/app/api/dealer/application/submit/route";
import { POST as franchiseStartPost } from "@/app/api/franchise/start/route";
import { DEALER_AGREEMENT_VERSION, type DealerDocType } from "@/lib/dealers";
import { encryptSecret, panBlindIndex } from "@/lib/pan-crypto";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  approvalRequests,
  auditLogs,
  bankAccounts,
  dealerDocuments,
  dealers,
  dealerVerifications,
  notificationDeliveries,
  onboardingRoleHistory,
  shops,
  userRoleGrants,
  users,
} from "@/server/db/schema";
import { DEALER_PROMOTION_APPROVAL, listPendingPromotions, shopDetailsForUser } from "@/server/dealers/promotion";
import { decideDealer, dealerView, reviewDealerDocument, uploadDealerDocument } from "@/server/dealers/service";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

type U = { id: string; email: string; name: string | null };
let admin: U;
let admin2: U;
let operator: U;

function signIn(user: U, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

const PAN = "ABCPS1234K";
const GSTIN = "27ABCPS1234K1Z5";
const ACCOUNT = "026291800001191";
const IFSC = "YESB0000262";
const PDF = Buffer.from("%PDF-1.4\n% test document\n");
const DATES = { agreementStart: "2026-11-28", agreementEnd: "2027-11-27" };

beforeEach(async () => {
  await resetDatabase();
  resetRateLimits();
  state.session = null;
  const mk = async (role: UserRole, name: string) => {
    const u = await createUser({ role, name });
    return { id: u.id, email: u.email, name: u.name };
  };
  admin = await mk("ADMIN", "Admin One");
  admin2 = await mk("ADMIN", "Admin Two");
  operator = await mk("OPERATOR", "Operator One");
  const actor = { id: admin.id, role: "ADMIN" as const };
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", actor);
  await setFeatureFlag("onboarding_v2", { enabled: true, districtCodes: null }, "on (test)", actor);
});

/** A shop owner with a live shop whose PAN, GSTIN, payout bank, mobile and e-mail are verified. */
async function verifiedShopOwner(opts: { bank?: boolean; panVerified?: boolean } = {}) {
  const user = await createUser({ role: "SHOP_OWNER", name: "Sai Patil" });
  const now = new Date();
  await db.update(users).set({ phoneVerifiedAt: now, emailVerified: now }).where(eq(users.id, user.id));
  const shop = await createShop(user.id, { name: `Sai Stores ${Math.random().toString(36).slice(2, 6)}`, status: "APPROVED", shopType: "GENERAL_TRADING" as never });
  await db
    .update(shops)
    .set({
      legalBusinessName: "Shree Sai Stores",
      state: "Maharashtra",
      gstin: GSTIN,
      gstStatus: "REGISTERED",
      gstVerifiedAt: now,
      gstVerificationSource: "PROVIDER_VERIFIED",
      gstTradeName: "SHREE SAI STORES",
      panNumberEncrypted: encryptSecret(PAN),
      panHash: panBlindIndex(PAN),
      panLast4: PAN.slice(-4),
      panHolderName: "SAI PATIL",
      ...(opts.panVerified === false ? { panStatus: "PENDING_VERIFICATION" as const } : { panStatus: "VERIFIED" as const, panVerifiedAt: now, panVerificationSource: "PROVIDER_VERIFIED" as const }),
    })
    .where(eq(shops.id, shop.id));
  if (opts.bank !== false) {
    await db.insert(bankAccounts).values({
      userId: user.id,
      shopId: shop.id,
      holderType: "SHOP",
      method: "BANK_ACCOUNT",
      accountHolderName: "Sai Patil",
      accountNumberEncrypted: encryptSecret(ACCOUNT),
      accountNumberLast4: ACCOUNT.slice(-4),
      ifsc: IFSC,
      status: "VERIFIED",
      verifiedAt: now,
      gatewayReference: "cf_test_1",
    });
  }
  const u = { id: user.id, email: user.email, name: user.name };
  return { user: u, shop, phone: user.phoneE164! };
}

async function freeRequest() {
  const o = await verifiedShopOwner();
  signIn(o.user, "SHOP_OWNER");
  const res = await call(franchiseStartPost, "/api/franchise/start", { method: "POST", body: { model: "free" } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body).toMatchObject({ status: "PENDING", code: null });
  const [dealer] = await db.select().from(dealers).where(eq(dealers.userId, o.user.id));
  return { ...o, dealer };
}

const approveAs = (who: U, dealerId: string) => {
  signIn(who, "ADMIN");
  return call(decisionPost, `/api/admin/dealers/${dealerId}/decision`, { method: "POST", params: { id: dealerId }, body: { action: "APPROVE", ...DATES } });
};
const decideAs = (who: U, role: UserRole, approvalId: string, decision: "APPROVE" | "REJECT", comment?: string) => {
  signIn(who, role);
  return call(decidePost, `/api/approvals/${approvalId}/decide`, { method: "POST", params: { id: approvalId }, body: { decision, comment: comment ?? null } });
};
const grants = (userId: string) => db.select().from(userRoleGrants).where(and(eq(userRoleGrants.userId, userId), eq(userRoleGrants.role, "DEALER")));

/* ================================================================ reuse */

describe("the shop's details are reused, nothing typed again", () => {
  it("free franchisee request: same account; name, mobile, e-mail, PAN, GSTIN, address and the verified bank from the shop, verified as the shop verified them", async () => {
    const { dealer, user, shop, phone } = await freeRequest();
    expect(dealer).toMatchObject({
      userId: user.id,
      source: "SHOP_REQUEST",
      status: "PENDING",
      legalName: "Shree Sai Stores",
      contactName: "Sai Patil",
      mobileE164: phone,
      email: user.email,
      gstin: GSTIN,
      panHash: panBlindIndex(PAN),
      addressLine1: "1 Test Road",
      city: "Pune",
      pincode: "411001",
      bankStatus: "VERIFIED",
      bankAccountLast4: "1191",
      bankIfsc: IFSC,
      bankHolderName: "Sai Patil",
    });
    expect(dealer.mobileVerifiedAt).not.toBeNull();
    expect(dealer.emailVerifiedAt).not.toBeNull();
    // PAN and GSTIN: the shop's verification, no second online check (no vendor call, provider SHOP_VERIFIED).
    const checks = await db.select().from(dealerVerifications).where(eq(dealerVerifications.dealerId, dealer.id));
    expect(checks.map((c) => `${c.docType}:${c.status}:${c.provider}`).sort()).toEqual(["GSTIN:VERIFIED:SHOP_VERIFIED", "PAN:VERIFIED:SHOP_VERIFIED"]);
    expect(checks.every((c) => c.providerRef === shop.id)).toBe(true);
    const view = await dealerView(dealer);
    for (const t of ["PAN", "GSTIN", "ADDRESS_PROOF", "BANK_PROOF"] as DealerDocType[]) {
      const r = view.requirements.find((x) => x.docType === t);
      if (r) expect(r.status, t).toBe("VERIFIED_ONLINE");
    }
    // The screens show the same details read-only.
    expect(await shopDetailsForUser(user.id)).toMatchObject({ legalName: "Shree Sai Stores", panVerified: true, gstVerified: true, mobileVerified: true, bank: { accountMasked: "••••1191", ifsc: IFSC } });
    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, dealer.id), eq(auditLogs.action, "dealer.application_saved")));
    expect(audit).toBeTruthy();
  });

  it("an unverified shop PAN is copied but not counted as verified; no verified bank → none copied", async () => {
    const o = await verifiedShopOwner({ bank: false, panVerified: false });
    signIn(o.user, "SHOP_OWNER");
    expect((await call(franchiseStartPost, "/api/franchise/start", { method: "POST", body: { model: "free" } })).status).toBe(201);
    const [d] = await db.select().from(dealers).where(eq(dealers.userId, o.user.id));
    expect(d.panHash).toBe(panBlindIndex(PAN));
    expect(d.bankStatus).toBe("NOT_PROVIDED");
    const checks = await db.select().from(dealerVerifications).where(eq(dealerVerifications.dealerId, d.id));
    expect(checks.map((c) => c.docType)).toEqual(["GSTIN"]);
  });

  it("/dealer/apply by a shop owner: only the dealer type and areas are given; the rest comes from the shop", async () => {
    const o = await verifiedShopOwner();
    signIn(o.user, "SHOP_OWNER");
    const saved = await call(appPut, "/api/dealer/application", {
      method: "PUT",
      body: { legalName: "", contactName: "", dealerType: "PROPRIETORSHIP", mobile: null, pan: null, gstin: null, addressLine1: "", city: "", pincode: "", territories: ["MH-PUN"], bank: null },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.dealer).toMatchObject({ legalName: "Shree Sai Stores", contactName: "Sai Patil", gstin: GSTIN, mobileVerified: true, panMasked: expect.stringContaining("234K"), bank: { status: "VERIFIED" } });
    const [d] = await db.select().from(dealers).where(eq(dealers.userId, o.user.id));
    expect(d).toMatchObject({ source: "APPLICATION", addressLine1: "1 Test Road", city: "Pune", pincode: "411001", panHash: panBlindIndex(PAN) });
    expect(saved.body.dealer.requirements.find((r: { docType: string }) => r.docType === "PAN")?.status).toBe("VERIFIED_ONLINE");
  });

  it("paid franchise start: the dealer account from the shop (bank verified), no approval request — live on payment as before", async () => {
    const o = await verifiedShopOwner();
    signIn(o.user, "SHOP_OWNER");
    const res = await call(franchiseStartPost, "/api/franchise/start", { method: "POST", body: { model: "paid" } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [d] = await db.select().from(dealers).where(eq(dealers.userId, o.user.id));
    expect(d).toMatchObject({ status: "DRAFT", bankStatus: "VERIFIED", gstin: GSTIN });
    expect(await db.select().from(approvalRequests).where(eq(approvalRequests.type, DEALER_PROMOTION_APPROVAL))).toHaveLength(0);
  });
});

/* ================================================================ four-eye */

describe("four-eye approval of a shop owner's promotion", () => {
  it("admin approves → pending (no code); the same admin cannot confirm; a second admin confirms → GKD code, role, history, e-mail", async () => {
    const { dealer, user } = await freeRequest();

    const proposed = await approveAs(admin, dealer.id);
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(202);
    expect(proposed.body).toMatchObject({ pendingApproval: true });
    const approvalId: string = proposed.body.approvalId;
    let [row] = await db.select().from(dealers).where(eq(dealers.id, dealer.id));
    expect(row.status).toBe("PENDING");
    expect(await grants(user.id)).toHaveLength(0);
    expect((await dealerView(row)).codes).toHaveLength(0);
    expect((await listPendingPromotions()).map((p) => p.dealerId)).toEqual([dealer.id]);

    // A second Approve while it waits is refused.
    expect((await approveAs(admin, dealer.id)).status).toBe(409);
    // Nobody confirms their own approval; a customer cannot confirm at all.
    const self = await decideAs(admin, "ADMIN", approvalId, "APPROVE");
    expect(self.status).toBe(403);
    expect(self.body.error.message).toMatch(/different person|your own/i);
    expect((await decideAs(user, "SHOP_OWNER", approvalId, "APPROVE")).status).toBe(403);
    // The service refuses an approval that skips the confirmation.
    await expect(decideDealer(dealer.id, { action: "APPROVE", ...DATES }, { id: admin2.id, role: "ADMIN" })).rejects.toMatchObject({ status: 409 });

    const confirmed = await decideAs(admin2, "ADMIN", approvalId, "APPROVE");
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ applied: true, applyError: null, singleAdmin: false });

    [row] = await db.select().from(dealers).where(eq(dealers.id, dealer.id));
    expect(row.status).toBe("APPROVED");
    expect(row.decidedBy).toBe(admin.id);
    const code = (await dealerView(row)).codes.find((c) => c.kind === "DEALER")?.code;
    expect(code).toMatch(/^GKD-[23456789A-Z]{6}$/);
    expect((await grants(user.id))[0]?.status).toBe("ACTIVE");
    const history = await db.select().from(onboardingRoleHistory).where(eq(onboardingRoleHistory.userId, user.id));
    expect(history.map((h) => `${h.role}:${h.action}`)).toEqual(["dealer_free:GRANTED"]);
    const mail = await db.select().from(notificationDeliveries).where(and(eq(notificationDeliveries.userId, user.id), eq(notificationDeliveries.type, "dealer.status_changed"), eq(notificationDeliveries.channel, "EMAIL")));
    expect(mail.some((m) => m.body.includes(code!))).toBe(true);
    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, dealer.id), eq(auditLogs.action, "dealer.status_changed")));
    expect(audit.newValue).toMatchObject({ status: "APPROVED", promotion: true, approvalId, confirmedBy: admin2.id });
    expect(await listPendingPromotions()).toHaveLength(0);
  });

  it("an operator may confirm; the shop owner's dealer application (/dealer/apply) is four-eye too", async () => {
    const o = await verifiedShopOwner();
    signIn(o.user, "SHOP_OWNER");
    const saved = await call(appPut, "/api/dealer/application", {
      method: "PUT",
      body: { legalName: "", contactName: "", dealerType: "PROPRIETORSHIP", mobile: null, pan: null, gstin: null, addressLine1: "", city: "", pincode: "", territories: ["MH-PUN"], bank: null },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const [d] = await db.select().from(dealers).where(eq(dealers.userId, o.user.id));
    const missing: DealerDocType[] = saved.body.dealer.requirements.filter((r: { required: boolean; status: string }) => r.required && r.status === "MISSING").map((r: { docType: DealerDocType }) => r.docType);
    for (const t of missing) await uploadDealerDocument({ id: o.user.id, role: "SHOP_OWNER" }, t, { name: `${t}.pdf`, bytes: PDF });
    const submitted = await call(submitPost, "/api/dealer/application/submit", { method: "POST", body: { agreementVersion: DEALER_AGREEMENT_VERSION } });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    for (const doc of await db.select().from(dealerDocuments).where(eq(dealerDocuments.dealerId, d.id))) await reviewDealerDocument(doc.id, "ACCEPTED", null, { id: admin.id, role: "ADMIN" });

    const proposed = await approveAs(admin, d.id);
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(202);
    const confirmed = await decideAs(operator, "OPERATOR", proposed.body.approvalId, "APPROVE");
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.applied).toBe(true);
    const [row] = await db.select().from(dealers).where(eq(dealers.id, d.id));
    expect(row.status).toBe("APPROVED");
    expect((await dealerView(row)).codes.some((c) => c.kind === "DEALER" && /^GKD-/.test(c.code))).toBe(true);
    const history = await db.select().from(onboardingRoleHistory).where(eq(onboardingRoleHistory.userId, o.user.id));
    expect(history.map((h) => `${h.role}:${h.action}`)).toEqual(["dealer_free:GRANTED"]);
  });

  it("reject: the second admin's rejection needs a reason; the application stays pending and can be approved again", async () => {
    const { dealer } = await freeRequest();
    const first = await approveAs(admin, dealer.id);
    expect(first.status).toBe(202);
    expect((await decideAs(admin2, "ADMIN", first.body.approvalId, "REJECT")).status).toBe(422);
    const rejected = await decideAs(admin2, "ADMIN", first.body.approvalId, "REJECT", "Call the owner first");
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.request.status).toBe("REJECTED");
    const [row] = await db.select().from(dealers).where(eq(dealers.id, dealer.id));
    expect(row.status).toBe("PENDING");
    expect((await dealerView(row)).codes).toHaveLength(0);
    // The admin who approved is told; he may approve again (a new request) — or another admin rejects the application.
    const again = await approveAs(admin, dealer.id);
    expect(again.status).toBe(202);
    expect(again.body.approvalId).not.toBe(first.body.approvalId);
    signIn(admin2, "ADMIN");
    const rejectApp = await call(decisionPost, `/api/admin/dealers/${dealer.id}/decision`, { method: "POST", params: { id: dealer.id }, body: { action: "REJECT", reason: "Not a fit for the area" } });
    expect(rejectApp.status, JSON.stringify(rejectApp.body)).toBe(200);
    // The confirmation that was still waiting can no longer approve a rejected application.
    const late = await decideAs(operator, "OPERATOR", again.body.approvalId, "APPROVE");
    expect(late.body.applied).toBe(false);
    expect(late.body.applyError).toMatch(/rejected/);
  });

  it("strict even for a lone Super Admin: with one admin the request waits for an operator", async () => {
    const { dealer } = await freeRequest();
    await db.update(users).set({ status: "SUSPENDED" }).where(eq(users.id, admin2.id));
    const { getEnv } = await import("@/lib/env");
    await db.update(users).set({ email: getEnv().SUPER_ADMIN_EMAIL }).where(eq(users.id, admin.id));
    const proposed = await approveAs({ ...admin, email: getEnv().SUPER_ADMIN_EMAIL }, dealer.id);
    expect(proposed.status).toBe(202);
    signIn({ ...admin, email: getEnv().SUPER_ADMIN_EMAIL }, "ADMIN");
    expect((await call(decidePost, `/api/approvals/${proposed.body.approvalId}/decide`, { method: "POST", params: { id: proposed.body.approvalId }, body: { decision: "APPROVE" } })).status).toBe(403);
    expect((await decideAs(operator, "OPERATOR", proposed.body.approvalId, "APPROVE")).body.applied).toBe(true);
  });

  it("a request whose shop is no longer live is refused at the admin's Approve (nothing sent for confirmation)", async () => {
    const { dealer, user } = await freeRequest();
    await db.update(shops).set({ status: "SUSPENDED" }).where(eq(shops.ownerId, user.id));
    const res = await approveAs(admin, dealer.id);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/no longer live/);
    expect(await db.select().from(approvalRequests).where(eq(approvalRequests.type, DEALER_PROMOTION_APPROVAL))).toHaveLength(0);
  });
});
