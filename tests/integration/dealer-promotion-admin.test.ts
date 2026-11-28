/**
 * Dealer / super dealer promotion (owner, 28-Nov-2026 ~20.00 IST; docs/dealer-promotion-2026-11/README.md), against
 * real PostgreSQL:
 *   - an OPERATOR may start (and reject) a shop owner's request to become a dealer; a different admin / operator
 *     confirms; an operator may not decide an application without a live shop;
 *   - a dealer asks to become a super dealer; one admin or operator approves (never the requester);
 *   - "also super dealer" asked before the dealer is approved: an admin's wish promotes at the approval, the shop
 *     owner's own wish raises a request;
 *   - Admin → Dealers → Promote: search a shop / dealer, make a live shop's owner a dealer (four-eye), make a dealer
 *     super (admin at once, operator by request);
 *   - rule referralMoves: off blocks new / approved moves; requireConsents off approves without letters;
 *   - the shop search no longer matches every shop for a name with no digits.
 */
import { and, eq, sql } from "drizzle-orm";
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
import { GET as promoteGet, POST as promotePost } from "@/app/api/admin/dealer-promotion/route";
import { POST as decidePost } from "@/app/api/approvals/[id]/decide/route";
import { GET as superGet, POST as superPost } from "@/app/api/dealer/super-request/route";
import { POST as franchiseStartPost } from "@/app/api/franchise/start/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { approvalRequests, dealers, referralMoveRequests, shops, superFranchisees, users } from "@/server/db/schema";
import { DEALER_PROMOTION_APPROVAL } from "@/server/dealers/promotion";
import { createMoveRequest, decideMoveRequest, missingDocuments, searchShopsForMove } from "@/server/dealers/referral-moves";
import { SUPER_DEALER_REQUEST } from "@/server/dealers/super-requests";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

type U = { id: string; email: string; name: string | null };
let admin: U;
let admin2: U;
let operator: U;
let operator2: U;

function signIn(user: U, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

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
  operator2 = await mk("OPERATOR", "Operator Two");
  const actor = { id: admin.id, role: "ADMIN" as const };
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: null }, "on (test)", actor);
  await setFeatureFlag("onboarding_v2", { enabled: true, districtCodes: null }, "on (test)", actor);
  await db.execute(sql`delete from platform_settings where key in ('referralMoves', 'superFranchisee')`);
  clearRuleCache();
});

/** A shop owner with a live shop and a verified mobile. */
async function shopOwner(name = "Deepak Wadabhat") {
  const user = await createUser({ role: "SHOP_OWNER", name });
  await db.update(users).set({ phoneVerifiedAt: new Date(), emailVerified: new Date() }).where(eq(users.id, user.id));
  const shop = await createShop(user.id, { name: `Khanduraya ${Math.random().toString(36).slice(2, 6)}`, status: "APPROVED", shopType: "GENERAL_TRADING" as never });
  await db.update(shops).set({ state: "Maharashtra", phone: "8554996458" }).where(eq(shops.id, shop.id));
  return { user: { id: user.id, email: user.email, name: user.name }, shop };
}

async function freeRequest(wantsSuper = false) {
  const o = await shopOwner();
  signIn(o.user, "SHOP_OWNER");
  const res = await call(franchiseStartPost, "/api/franchise/start", { method: "POST", body: { model: "free", wantsSuper } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const [dealer] = await db.select().from(dealers).where(eq(dealers.userId, o.user.id));
  return { ...o, dealer };
}

const decideAs = (who: U, role: UserRole, approvalId: string, decision: "APPROVE" | "REJECT", comment?: string) => {
  signIn(who, role);
  return call(decidePost, `/api/approvals/${approvalId}/decide`, { method: "POST", params: { id: approvalId }, body: { decision, comment: comment ?? null } });
};
const dealerOf = async (userId: string) => (await db.select().from(dealers).where(eq(dealers.userId, userId)))[0];
const isSuper = async (dealerId: string) => (await db.select().from(superFranchisees).where(and(eq(superFranchisees.dealerId, dealerId), eq(superFranchisees.status, "ACTIVE")))).length === 1;

/* ================================================================ operator approves */

describe("an operator approves or rejects a shop owner's request to become a dealer", () => {
  it("operator starts the approval, a different operator confirms → dealer with a GKD code", async () => {
    const { dealer } = await freeRequest();
    signIn(operator, "OPERATOR");
    const first = await call(decisionPost, `/api/admin/dealers/${dealer.id}/decision`, { method: "POST", params: { id: dealer.id }, body: { action: "APPROVE", ...DATES } });
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    const approvalId = (first.body as { approvalId: string }).approvalId;
    const self = await decideAs(operator, "OPERATOR", approvalId, "APPROVE");
    expect(self.status).toBe(403);
    const ok = await decideAs(operator2, "OPERATOR", approvalId, "APPROVE");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await dealerOf(dealer.userId!)).status).toBe("APPROVED");
  });

  it("operator rejects a shop owner's request; cannot decide an applicant without a live shop, nor suspend", async () => {
    const { dealer } = await freeRequest();
    signIn(operator, "OPERATOR");
    const rej = await call(decisionPost, `/api/admin/dealers/${dealer.id}/decision`, { method: "POST", params: { id: dealer.id }, body: { action: "REJECT", reason: "not a fit right now" } });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect((await dealerOf(dealer.userId!)).status).toBe("REJECTED");

    const plain = await createUser({ role: "CUSTOMER" });
    const [other] = await db.insert(dealers).values({ userId: plain.id, legalName: "No Shop Co", contactName: "No Shop", dealerType: "INDIVIDUAL", status: "PENDING" }).returning();
    signIn(operator, "OPERATOR");
    const no = await call(decisionPost, `/api/admin/dealers/${other.id}/decision`, { method: "POST", params: { id: other.id }, body: { action: "APPROVE", ...DATES } });
    expect(no.status).toBe(403);
    const susp = await call(decisionPost, `/api/admin/dealers/${other.id}/decision`, { method: "POST", params: { id: other.id }, body: { action: "SUSPEND", reason: "testing the rule" } });
    expect(susp.status).toBe(403);
  });
});

/* ================================================================ super dealer requests */

describe("a dealer asks to become a super dealer", () => {
  it("approved dealer requests → an operator approves → super dealer; the requester's account cannot decide", async () => {
    const { dealer, user } = await freeRequest();
    await db.update(dealers).set({ status: "APPROVED" }).where(eq(dealers.id, dealer.id));
    signIn(user, "SHOP_OWNER");
    const res = await call(superPost, "/api/dealer/super-request", { method: "POST", body: {} });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: "PENDING" });
    const [req] = await db.select().from(approvalRequests).where(eq(approvalRequests.type, SUPER_DEALER_REQUEST));
    expect(req.subjectId).toBe(dealer.id);
    // a second ask does not raise a second request
    await call(superPost, "/api/dealer/super-request", { method: "POST", body: {} });
    expect((await db.select().from(approvalRequests).where(eq(approvalRequests.type, SUPER_DEALER_REQUEST))).length).toBe(1);
    const ok = await decideAs(operator, "OPERATOR", req.id, "APPROVE");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await isSuper(dealer.id)).toBe(true);
    signIn(user, "SHOP_OWNER");
    expect((await call(superGet, "/api/dealer/super-request")).body).toMatchObject({ status: "SUPER" });
  });

  it("a rejection leaves him a dealer and tells him why", async () => {
    const { dealer, user } = await freeRequest();
    await db.update(dealers).set({ status: "APPROVED" }).where(eq(dealers.id, dealer.id));
    signIn(user, "SHOP_OWNER");
    await call(superPost, "/api/dealer/super-request", { method: "POST", body: {} });
    const [req] = await db.select().from(approvalRequests).where(eq(approvalRequests.type, SUPER_DEALER_REQUEST));
    const no = await decideAs(admin, "ADMIN", req.id, "REJECT", "build a team first");
    expect(no.status, JSON.stringify(no.body)).toBe(200);
    expect(await isSuper(dealer.id)).toBe(false);
    expect((await dealerOf(user.id)).status).toBe("APPROVED");
  });

  it("no dealer account → 409 with the way to become one", async () => {
    const o = await shopOwner();
    signIn(o.user, "SHOP_OWNER");
    const res = await call(superPost, "/api/dealer/super-request", { method: "POST", body: {} });
    expect(res.status).toBe(409);
  });

  it("asked with the free request: kept, and raised as a request when the dealer is approved", async () => {
    const { dealer, user } = await freeRequest(true);
    expect((await dealerOf(user.id)).wantsSuperAt).not.toBeNull();
    signIn(user, "SHOP_OWNER");
    expect((await call(superGet, "/api/dealer/super-request")).body).toMatchObject({ status: "AFTER_DEALER_APPROVAL" });
    signIn(admin, "ADMIN");
    const first = await call(decisionPost, `/api/admin/dealers/${dealer.id}/decision`, { method: "POST", params: { id: dealer.id }, body: { action: "APPROVE", ...DATES } });
    expect(first.status).toBe(202);
    const confirm = await decideAs(operator, "OPERATOR", (first.body as { approvalId: string }).approvalId, "APPROVE");
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
    const d = await dealerOf(user.id);
    expect(d.status).toBe("APPROVED");
    expect(d.wantsSuperAt).toBeNull();
    const reqs = await db.select().from(approvalRequests).where(and(eq(approvalRequests.type, SUPER_DEALER_REQUEST), eq(approvalRequests.status, "PENDING")));
    expect(reqs.map((r) => r.subjectId)).toEqual([dealer.id]);
    expect(await isSuper(dealer.id)).toBe(false);
  });
});

/* ================================================================ admin search and promote */

describe("Admin → Dealers → Promote", () => {
  it("search finds the shop owner by shop name, owner name and mobile", async () => {
    const o = await shopOwner("Dipak Dinkarrao Wadabhat");
    signIn(operator, "OPERATOR");
    for (const q of ["Khanduraya", "Dinkarrao", "85549964"]) {
      const res = await call(promoteGet, `/api/admin/dealer-promotion?q=${encodeURIComponent(q)}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const results = (res.body as { results: { ownerId: string; dealer: unknown; shops: { live: boolean }[] }[] }).results;
      expect(results.map((r) => r.ownerId)).toContain(o.user.id);
      expect(results.find((r) => r.ownerId === o.user.id)).toMatchObject({ dealer: null, shops: [{ live: true }] });
    }
    signIn(o.user, "SHOP_OWNER");
    expect((await call(promoteGet, "/api/admin/dealer-promotion?q=Khanduraya")).status).toBe(403);
  });

  it("admin promotes a shop owner with 'also super dealer' → a different admin confirms → dealer AND super dealer", async () => {
    const o = await shopOwner();
    signIn(admin, "ADMIN");
    const res = await call(promotePost, "/api/admin/dealer-promotion", { method: "POST", body: { action: "promoteShopOwner", shopId: o.shop.id, alsoSuper: true, reason: "owner asked" } });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const d = await dealerOf(o.user.id);
    expect(d).toMatchObject({ status: "PENDING", source: "SHOP_REQUEST" });
    const [req] = await db.select().from(approvalRequests).where(eq(approvalRequests.type, DEALER_PROMOTION_APPROVAL));
    expect((await decideAs(admin, "ADMIN", req.id, "APPROVE")).status).toBe(403);
    const ok = await decideAs(admin2, "ADMIN", req.id, "APPROVE");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await dealerOf(o.user.id)).status).toBe("APPROVED");
    expect(await isSuper(d.id)).toBe(true);
  });

  it("a shop that is not live cannot be promoted", async () => {
    const user = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(user.id, { name: "Not live", status: "PENDING_APPROVAL", shopType: "GENERAL_TRADING" as never });
    signIn(admin, "ADMIN");
    const res = await call(promotePost, "/api/admin/dealer-promotion", { method: "POST", body: { action: "promoteShopOwner", shopId: shop.id } });
    expect(res.status).toBe(409);
  });

  it("make super dealer: an admin at once; an operator raises a request another person approves", async () => {
    const a = await freeRequest();
    await db.update(dealers).set({ status: "APPROVED" }).where(eq(dealers.id, a.dealer.id));
    signIn(admin, "ADMIN");
    const now = await call(promotePost, "/api/admin/dealer-promotion", { method: "POST", body: { action: "makeSuper", dealerId: a.dealer.id, reason: "leads the Pune team" } });
    expect(now.status, JSON.stringify(now.body)).toBe(200);
    expect(await isSuper(a.dealer.id)).toBe(true);

    const user = await createUser({ role: "DEALER" });
    const [b] = await db.insert(dealers).values({ userId: user.id, legalName: "Dealer B", contactName: "B", dealerType: "INDIVIDUAL", status: "APPROVED" }).returning();
    signIn(operator, "OPERATOR");
    const asked = await call(promotePost, "/api/admin/dealer-promotion", { method: "POST", body: { action: "makeSuper", dealerId: b.id, reason: "leads the Nashik team" } });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(await isSuper(b.id)).toBe(false);
    const id = (asked.body as { approvalId: string }).approvalId;
    expect((await decideAs(operator, "OPERATOR", id, "APPROVE")).status).toBe(403);
    expect((await decideAs(admin, "ADMIN", id, "APPROVE")).status).toBe(200);
    expect(await isSuper(b.id)).toBe(true);
  });
});

/* ================================================================ referral moves switch */

describe("rule referralMoves", () => {
  async function moveSetup() {
    const user = await createUser({ role: "DEALER" });
    const [to] = await db.insert(dealers).values({ userId: user.id, legalName: "Target Dealer", contactName: "T", dealerType: "INDIVIDUAL", status: "APPROVED" }).returning();
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { name: "Moving Shop", status: "APPROVED", shopType: "GENERAL_TRADING" as never });
    return { to, shop };
  }
  const A = () => ({ id: admin.id, role: "ADMIN" as const });
  const A2 = () => ({ id: admin2.id, role: "ADMIN" as const });

  it("off: no new request, and a waiting one cannot be approved", async () => {
    const { to, shop } = await moveSetup();
    const r = await createMoveRequest({ kind: "SHOPS", shopIds: [shop.id], toDealerId: to.id, reason: "internal merge of codes" }, A());
    await setRule("referralMoves", { enabled: false, requireConsents: true }, A());
    clearRuleCache();
    await expect(createMoveRequest({ kind: "SHOPS", shopIds: [shop.id], toDealerId: to.id, reason: "another request here" }, A())).rejects.toThrow(/switched off/);
    await expect(decideMoveRequest(r.id, { approve: true, note: "fine by me" }, A2())).rejects.toThrow(/switched off/);
    // rejecting a waiting one still works
    await decideMoveRequest(r.id, { approve: false, note: "not now" }, A2());
    expect((await db.select().from(referralMoveRequests).where(eq(referralMoveRequests.id, r.id)))[0].status).toBe("REJECTED");
  });

  it("requireConsents off: approved without letters; on (default): letters required", async () => {
    const { to, shop } = await moveSetup();
    const r = await createMoveRequest({ kind: "SHOPS", shopIds: [shop.id], toDealerId: to.id, reason: "internal merge of codes" }, A());
    expect((await missingDocuments(r)).length).toBeGreaterThan(0);
    await expect(decideMoveRequest(r.id, { approve: true, note: "fine by me" }, A2())).rejects.toThrow(/consent letters/);
    await setRule("referralMoves", { enabled: true, requireConsents: false }, A());
    clearRuleCache();
    expect(await missingDocuments(r)).toEqual([]);
    const done = await decideMoveRequest(r.id, { approve: true, note: "internal, letters waived by rule" }, A2());
    expect(done.status).toBe("APPROVED");
    await expect(decideMoveRequest(r.id, { approve: true, note: "again" }, A2())).rejects.toThrow();
  });

  it("the shop search matches by name only when the term has no digits", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    for (const n of ["Alpha Kirana", "Beta Medical", "Gamma Foods"]) {
      const s = await createShop(owner.id, { name: n, status: "APPROVED", shopType: "GENERAL_TRADING" as never });
      await db.update(shops).set({ phone: `98${Math.floor(10_000_000 + Math.random() * 89_999_999)}` }).where(eq(shops.id, s.id));
    }
    const rows = await searchShopsForMove("Beta");
    expect(rows.map((r) => r.name)).toEqual(["Beta Medical"]);
  });
});
