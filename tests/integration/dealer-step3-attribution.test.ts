/**
 * Dealer programme step 3 (docs/dealer-programme, GKS-SH-001…003, GKS-RA-001):
 * which dealer brought a shop.
 *
 * Scenarios (build prompt §5): 11 no code → no dealer; 13 dealer code; 14
 * employee code; 15 legacy code → GoKesari Direct; the optional Employee ID
 * matched to the dealer's employee; 17 dealer-assisted registration needs the
 * owner's code, the shop is the owner's and carries the dealer's code; 31 a
 * lead wins a code-less registration; 32 a code at registration beats an
 * earlier lead, which is closed with the reason; 33 an expired lead does not
 * count; 34 the open-lead cap; 35 a shop already on GoKesari is no lead and a
 * repeat registration is flagged duplicate; 36 the same owner's second shop is a
 * branch; 37 a claim upheld moves the shop; 72/73 programme off, or off in that
 * district → nothing recorded and registration unchanged; ?ref= link.
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { POST as decidePost } from "@/app/api/admin/dealer-disputes/[id]/route";
import { POST as assistedStart } from "@/app/api/dealer/assisted/route";
import { POST as assistedShop } from "@/app/api/dealer/assisted/[id]/shop/route";
import { POST as assistedVerify } from "@/app/api/dealer/assisted/[id]/verify/route";
import { GET as disputesGet, POST as disputesPost } from "@/app/api/dealer/disputes/route";
import { POST as leadPost } from "@/app/api/dealer/leads/route";
import { GET as myShopsGet } from "@/app/api/dealer/shops/route";
import { POST as shopRegisterRoute } from "@/app/api/shops/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  dealerAttributionDisputes,
  dealerLeads,
  dealers,
  dealerSalespeople,
  notifications,
  outboundTestMessages,
  platformSettings,
  shopAttributions,
  shopCategories,
  shops,
  users,
} from "@/server/db/schema";
import { issueCode, salespersonCode, dealerCodeFor } from "@/server/dealers/codes";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { createReferralCode } from "@/server/services/referrals";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createUser, resetDatabase, uniqueMobile } from "../helpers/fixtures";

type U = { id: string; email: string; name: string | null };
let admin: U & { role: "ADMIN" };
let categoryIds: string[] = [];
let counter = 0;

function signIn(user: U, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

beforeAll(async () => {
  categoryIds = (await db.select({ id: shopCategories.id }).from(shopCategories).limit(1)).map((r) => r.id);
});

beforeEach(async () => {
  await resetDatabase();
  await db.delete(outboundTestMessages);
  await db.delete(platformSettings).where(eq(platformSettings.key, "dealerProgramme"));
  clearRuleCache();
  resetRateLimits();
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, email: a.email, name: a.name, role: "ADMIN" };
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", admin);
});

/** An approved dealer with a signed-in account, its GKS-MH-PUN code, and (optionally) one employee with a code. */
async function approvedDealer(name: string, withEmployee = false) {
  const user = await createUser({ role: "DEALER", name });
  const [dealer] = await db
    .insert(dealers)
    .values({ userId: user.id, legalName: name, contactName: name, dealerType: "PROPRIETORSHIP", status: "APPROVED", mobileE164: `+91${uniqueMobile()}`, decidedAt: new Date() })
    .returning();
  const { code } = await db.transaction((tx) => issueCode(tx, { dealerId: dealer.id, kind: "DEALER", makeCode: () => dealerCodeFor("PUN"), label: name }, admin));
  let employee: { id: string; code: string } | null = null;
  if (withEmployee) {
    const [person] = await db.insert(dealerSalespeople).values({ dealerId: dealer.id, employeeId: "EMP-7", name: "Ravi Jadhav" }).returning();
    const issued = await db.transaction((tx) => issueCode(tx, { dealerId: dealer.id, salespersonId: person.id, kind: "SALESPERSON", makeCode: salespersonCode, label: "Ravi" }, admin));
    employee = { id: person.id, code: issued.code };
  }
  return { user, dealer, code, employee };
}

function shopBody(extra: Record<string, unknown> = {}) {
  counter += 1;
  return {
    name: `Ganesh Kirana ${counter}`,
    ownerName: "Ramesh Patil",
    phone: uniqueMobile(),
    addressLine1: `${counter} FC Road`,
    city: "Pune",
    pincode: "411004",
    shopType: "GROCERY_KIRANA",
    annualTurnoverRupees: 1_500_000,
    categoryIds,
    shopActNumber: `PII/KOTHRUD/II/${30000 + counter}`,
    ...extra,
  };
}

async function selfRegister(extra: Record<string, unknown> = {}, owner?: U) {
  const u = owner ?? (await createUser());
  signIn(u, "CUSTOMER");
  const res = await call(shopRegisterRoute, "/api/shops", { method: "POST", body: shopBody(extra) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { shopId: res.body.id as string, owner: u };
}

const attributionOf = async (shopId: string) => (await db.select().from(shopAttributions).where(eq(shopAttributions.shopId, shopId)))[0] ?? null;

describe("codes at registration (scenarios 11, 13, 14, 15)", () => {
  it("no code: no dealer", async () => {
    const { shopId } = await selfRegister();
    expect(await attributionOf(shopId)).toBeNull();
  });

  it("a dealer code: the dealer; the optional Employee ID matches one of the dealer's employees", async () => {
    const d = await approvedDealer("Shree Sai Distributors", true);
    const { shopId } = await selfRegister({ referralCode: d.code, employeeId: "emp-7" });
    expect(await attributionOf(shopId)).toMatchObject({ dealerId: d.dealer.id, salespersonId: d.employee!.id, source: "CODE_AT_REGISTRATION", employeeText: "emp-7", matchKind: "NONE" });
    // The dealer is told, and sees the shop as theirs.
    const [note] = await db.select().from(notifications).where(and(eq(notifications.userId, d.user.id), eq(notifications.type, "dealer.shop_attributed")));
    expect(note.body).toContain("Ravi Jadhav");
    signIn(d.user, "DEALER");
    const mine = await call(myShopsGet, "/api/dealer/shops");
    expect(mine.body.shops.map((s: { shopId: string }) => s.shopId)).toEqual([shopId]);
  });

  it("an unknown Employee ID keeps the text and counts the shop for the dealer alone", async () => {
    const d = await approvedDealer("Kale Agencies", true);
    const { shopId } = await selfRegister({ referralCode: d.code, employeeId: "Suresh" });
    expect(await attributionOf(shopId)).toMatchObject({ dealerId: d.dealer.id, salespersonId: null, employeeText: "Suresh" });
  });

  it("an employee's code: the dealer and that employee", async () => {
    const d = await approvedDealer("Patil Traders", true);
    const { shopId } = await selfRegister({ referralCode: d.employee!.code });
    expect(await attributionOf(shopId)).toMatchObject({ dealerId: d.dealer.id, salespersonId: d.employee!.id });
  });

  it("a legacy code with no dealer link: GoKesari Direct (internal)", async () => {
    await createReferralCode({ code: "OLD-PUNE-1", label: "launch" }, admin);
    const { shopId } = await selfRegister({ referralCode: "OLD-PUNE-1" });
    const a = await attributionOf(shopId);
    const [direct] = await db.select().from(dealers).where(eq(dealers.id, a!.dealerId));
    expect(direct.isInternal).toBe(true);
  });
});

describe("programme off, or off in the shop's district (scenarios 72, 73)", () => {
  it("off: nothing is recorded and the registration is exactly as before", async () => {
    const d = await approvedDealer("Shree Sai Distributors");
    await setFeatureFlag("dealer_programme_enabled", { enabled: false, districtCodes: null }, "off (test)", admin);
    const { shopId } = await selfRegister({ referralCode: d.code, employeeId: "EMP-7" });
    expect(await attributionOf(shopId)).toBeNull();
    const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
    expect(shop).toMatchObject({ status: "PENDING_APPROVAL" });
    expect(shop.referralCodeId).not.toBeNull();
  });

  it("on for Pune only: a Mumbai shop is not attributed", async () => {
    const d = await approvedDealer("Shree Sai Distributors");
    const { shopId } = await selfRegister({ referralCode: d.code, pincode: "400001", city: "Mumbai" });
    expect(await attributionOf(shopId)).toBeNull();
  });
});

describe("leads (scenarios 31, 32, 33, 34, 35)", () => {
  const lead = (mobile: string, extra: Record<string, unknown> = {}) => ({ shopName: "Ganesh Kirana", mobile, pincode: "411004", ownerConsent: true, ...extra });

  it("Dealer A's lead wins a registration without a code; Dealer B's later lead is closed", async () => {
    const a = await approvedDealer("Dealer A");
    const b = await approvedDealer("Dealer B");
    const mobile = uniqueMobile();
    signIn(a.user, "DEALER");
    expect((await call(leadPost, "/api/dealer/leads", { method: "POST", body: lead(mobile) })).status).toBe(201);
    signIn(b.user, "DEALER");
    expect((await call(leadPost, "/api/dealer/leads", { method: "POST", body: lead(mobile) })).status).toBe(201);
    const { shopId } = await selfRegister({ phone: mobile });
    expect(await attributionOf(shopId)).toMatchObject({ dealerId: a.dealer.id, source: "LEAD" });
    const leads = await db.select().from(dealerLeads);
    expect(leads.find((l) => l.dealerId === a.dealer.id)!.status).toBe("CONVERTED");
    expect(leads.find((l) => l.dealerId === b.dealer.id)).toMatchObject({ status: "CLOSED" });
  });

  it("a code at registration beats an earlier lead; that lead is closed with the reason and its dealer told", async () => {
    const a = await approvedDealer("Dealer A");
    const b = await approvedDealer("Dealer B");
    const mobile = uniqueMobile();
    signIn(a.user, "DEALER");
    await call(leadPost, "/api/dealer/leads", { method: "POST", body: lead(mobile) });
    const { shopId } = await selfRegister({ phone: mobile, referralCode: b.code });
    expect(await attributionOf(shopId)).toMatchObject({ dealerId: b.dealer.id, source: "CODE_AT_REGISTRATION" });
    const [aLead] = await db.select().from(dealerLeads).where(eq(dealerLeads.dealerId, a.dealer.id));
    expect(aLead).toMatchObject({ status: "CLOSED", closedReason: "the shop registered with another dealer's code" });
    const told = await db.select().from(notifications).where(and(eq(notifications.userId, a.user.id), eq(notifications.type, "dealer.lead_closed")));
    expect(told).toHaveLength(1);
  });

  it("an expired lead does not count", async () => {
    const a = await approvedDealer("Dealer A");
    const mobile = uniqueMobile();
    signIn(a.user, "DEALER");
    await call(leadPost, "/api/dealer/leads", { method: "POST", body: lead(mobile) });
    await db.update(dealerLeads).set({ expiresAt: new Date(Date.now() - 1000) });
    const { shopId } = await selfRegister({ phone: mobile });
    expect(await attributionOf(shopId)).toBeNull();
    expect((await db.select().from(dealerLeads))[0].status).toBe("EXPIRED");
  });

  it("a lead needs the owner's consent; the open-lead cap stops mass reservation; a shop already on GoKesari is no lead", async () => {
    const a = await approvedDealer("Dealer A");
    signIn(a.user, "DEALER");
    expect((await call(leadPost, "/api/dealer/leads", { method: "POST", body: lead(uniqueMobile(), { ownerConsent: false }) })).status).toBe(422);
    await setRule("dealerProgramme", { maxOpenLeadsPerDealer: 2 }, admin);
    clearRuleCache();
    expect((await call(leadPost, "/api/dealer/leads", { method: "POST", body: lead(uniqueMobile()) })).status).toBe(201);
    expect((await call(leadPost, "/api/dealer/leads", { method: "POST", body: lead(uniqueMobile()) })).status).toBe(201);
    const capped = await call(leadPost, "/api/dealer/leads", { method: "POST", body: lead(uniqueMobile()) });
    expect(capped.status).toBe(409);
    expect(capped.body.error.message).toMatch(/most allowed/);

    await selfRegister({ phone: "9811122233" });
    signIn(a.user, "DEALER");
    await db.delete(dealerLeads);
    const onGoKesari = await call(leadPost, "/api/dealer/leads", { method: "POST", body: lead("9811122233") });
    expect(onGoKesari.status).toBe(409);
    expect(onGoKesari.body.error.message).toMatch(/already on GoKesari/);
    // Outside the open districts: refused.
    expect((await call(leadPost, "/api/dealer/leads", { method: "POST", body: lead(uniqueMobile(), { pincode: "400001" }) })).status).toBe(422);
  });
});

describe("duplicates and branches (scenarios 35, 36)", () => {
  it("another owner's shop with the same mobile is flagged a likely duplicate; the same owner's second shop is a branch", async () => {
    const d = await approvedDealer("Shree Sai Distributors");
    const first = await selfRegister({ phone: "9822233344" });
    const dup = await selfRegister({ phone: "9822233344", referralCode: d.code, name: "Another Name Entirely" });
    expect(await attributionOf(dup.shopId)).toMatchObject({ matchKind: "DUPLICATE", matchedShopId: first.shopId, matchReasons: ["MOBILE"] });

    // Same owner, different place and name: a branch (registered for the owner by an operator, as staff do).
    const op = await createUser({ role: "OPERATOR" });
    signIn(op, "OPERATOR");
    const branch = await call(shopRegisterRoute, "/api/shops", {
      method: "POST",
      body: shopBody({ phone: "9822233344", ownerId: first.owner.id, referralCode: d.code, name: "Ganesh Kirana Kothrud Branch", addressLine1: "88 Paud Road", pincode: "411038" }),
    });
    expect(branch.status, JSON.stringify(branch.body)).toBe(201);
    expect(await attributionOf(branch.body.id)).toMatchObject({ dealerId: d.dealer.id, matchKind: "BRANCH", matchedShopId: first.shopId });
  });
});

describe("dealer-assisted registration (scenario 17)", () => {
  it("needs the owner's code; the shop is the owner's, carries the dealer's code, and the owner is asked to pay", async () => {
    const d = await approvedDealer("Shree Sai Distributors", true);
    signIn(d.user, "DEALER");
    const ownerMobile = uniqueMobile();
    const started = await call(assistedStart, "/api/dealer/assisted", {
      method: "POST",
      body: { ownerName: "Sunita Kale", ownerMobile, ownerEmail: `sunita-${ownerMobile}@test.local`, salespersonId: d.employee!.id },
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const sessionId = started.body.session.id as string;

    // Without the owner's code nothing is registered.
    const early = await call(assistedShop, `/api/dealer/assisted/${sessionId}/shop`, { method: "POST", params: { id: sessionId }, body: { ownerAcceptedTerms: true, shop: shopBody({ phone: ownerMobile }) } });
    expect(early.status).toBe(403);
    expect((await call(assistedVerify, `/api/dealer/assisted/${sessionId}/verify`, { method: "POST", params: { id: sessionId }, body: { code: "000000" } })).status).toBe(422);

    const [sms] = (await db.select().from(outboundTestMessages).where(eq(outboundTestMessages.toAddress, `+91${ownerMobile}`))).slice(-1);
    expect(sms.body).toContain("Shree Sai Distributors");
    const code = /(\d{4,8})/.exec(sms.body)![1];
    const verified = await call(assistedVerify, `/api/dealer/assisted/${sessionId}/verify`, { method: "POST", params: { id: sessionId }, body: { code } });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);

    // The owner must accept the terms.
    expect((await call(assistedShop, `/api/dealer/assisted/${sessionId}/shop`, { method: "POST", params: { id: sessionId }, body: { ownerAcceptedTerms: false, shop: shopBody({ phone: ownerMobile }) } })).status).toBe(422);
    const done = await call(assistedShop, `/api/dealer/assisted/${sessionId}/shop`, { method: "POST", params: { id: sessionId }, body: { ownerAcceptedTerms: true, shop: shopBody({ phone: ownerMobile }) } });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.code).toBe(d.employee!.code);
    expect(done.body.feeDuePaise).toBeGreaterThan(0);

    const [shop] = await db.select().from(shops).where(eq(shops.id, done.body.shop.id));
    const [owner] = await db.select().from(users).where(eq(users.id, shop.ownerId));
    expect(owner.email).toBe(`sunita-${ownerMobile}@test.local`);
    expect(shop.ownerId).not.toBe(d.user.id);
    expect(shop.status).toBe("PENDING_APPROVAL");
    expect(await attributionOf(shop.id)).toMatchObject({ dealerId: d.dealer.id, salespersonId: d.employee!.id, source: "DEALER_ASSISTED" });
    const asked = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "dealer.assisted_shop_registered")));
    expect(asked).toHaveLength(1);
  });
});

describe("attribution claims (scenario 37)", () => {
  it("a claim never reveals the shop to the dealer; staff uphold it and the shop moves, logged", async () => {
    const a = await approvedDealer("Dealer A");
    const b = await approvedDealer("Dealer B");
    const mobile = uniqueMobile();
    const { shopId } = await selfRegister({ phone: mobile, referralCode: b.code });
    signIn(a.user, "DEALER");
    expect((await call(disputesPost, "/api/dealer/disputes", { method: "POST", body: { mobile, note: "I visited them on Monday with our brochure." } })).status).toBe(201);
    // The same answer for a mobile that is not a shop at all.
    expect((await call(disputesPost, "/api/dealer/disputes", { method: "POST", body: { mobile: uniqueMobile(), note: "Another shop we visited last week." } })).status).toBe(201);
    const mine = await call(disputesGet, "/api/dealer/disputes");
    expect(mine.body.disputes.every((d: { shopId: string | null; shopName: string | null }) => d.shopId === null && d.shopName === null)).toBe(true);

    const [claim] = await db.select().from(dealerAttributionDisputes).where(eq(dealerAttributionDisputes.shopId, shopId));
    // A dealer cannot decide claims.
    expect((await call(decidePost, `/api/admin/dealer-disputes/${claim.id}`, { method: "POST", params: { id: claim.id }, body: { decision: "UPHELD", note: "self approve" } })).status).toBe(403);
    const op = await createUser({ role: "OPERATOR" });
    signIn(op, "OPERATOR");
    const decided = await call(decidePost, `/api/admin/dealer-disputes/${claim.id}`, { method: "POST", params: { id: claim.id }, body: { decision: "UPHELD", note: "Dealer A's visit report and photos are dated before the registration." } });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(await attributionOf(shopId)).toMatchObject({ dealerId: a.dealer.id, source: "ADMIN" });
  });
});
