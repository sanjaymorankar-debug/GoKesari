/**
 * Dealer programme step 6 (docs/dealer-programme, GKS-DB-001): the dealer's
 * board — shops by stage, pending registrations, onboarding by period,
 * employees' and areas' results — and the staff overview (rating list).
 * A dealer sees only their own (scenario 68); document requirements are
 * admin-only (scenario 69).
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { PUT as requirementsPut } from "@/app/api/admin/dealer-document-requirements/route";
import { db } from "@/server/db";
import { dealerAssistedSessions, dealerLeads, dealers, dealerSalespeople, shopAttributions, shops } from "@/server/db/schema";
import { dealerPerformance, dealersOverview } from "@/server/dealers/performance";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

let admin: { id: string; email: string; name: string | null; role: "ADMIN" };

beforeEach(async () => {
  await resetDatabase();
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, email: a.email, name: a.name, role: "ADMIN" };
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", admin);
});

async function dealerWith(name: string) {
  const user = await createUser({ role: "DEALER" });
  const [dealer] = await db.insert(dealers).values({ userId: user.id, legalName: name, contactName: name, dealerType: "PROPRIETORSHIP", status: "APPROVED", rating: 5.5, activatedShops: 1 }).returning();
  return { user, dealer };
}

async function shopFor(dealerId: string, opts: { pincode: string; status: "PENDING_APPROVAL" | "APPROVED"; salespersonId?: string | null; activated?: boolean; createdAt?: Date }) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: `Shop ${opts.pincode} ${Math.random().toString(36).slice(2, 6)}`, status: opts.status, shopType: "GENERAL_TRADING" as never });
  await db.update(shops).set({ pincode: opts.pincode, area: null, city: "Pune" }).where(eq(shops.id, shop.id));
  await db.insert(shopAttributions).values({
    shopId: shop.id,
    dealerId,
    salespersonId: opts.salespersonId ?? null,
    source: "CODE_AT_REGISTRATION",
    activatedAt: opts.activated ? new Date() : null,
    createdAt: opts.createdAt ?? new Date(),
  });
  return shop;
}

describe("the dealer's board", () => {
  it("counts shops, live shops, pending registrations; groups by employee, area and period; only this dealer's", async () => {
    const a = await dealerWith("Dealer A");
    const b = await dealerWith("Dealer B");
    const [ravi] = await db.insert(dealerSalespeople).values({ dealerId: a.dealer.id, employeeId: "E1", name: "Ravi" }).returning();
    await db.insert(dealerSalespeople).values({ dealerId: a.dealer.id, employeeId: "E2", name: "Asha" });

    await shopFor(a.dealer.id, { pincode: "411038", status: "APPROVED", salespersonId: ravi.id, activated: true });
    await shopFor(a.dealer.id, { pincode: "411038", status: "PENDING_APPROVAL", salespersonId: ravi.id });
    await shopFor(a.dealer.id, { pincode: "411057", status: "PENDING_APPROVAL", createdAt: new Date(Date.now() - 40 * 86_400_000) });
    await shopFor(b.dealer.id, { pincode: "411038", status: "APPROVED", activated: true });
    await db.insert(dealerLeads).values({ dealerId: a.dealer.id, salespersonId: ravi.id, shopName: "Lead shop", phoneE164: "+919811100001", consentAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) });
    await db.insert(dealerAssistedSessions).values({ dealerId: a.dealer.id, ownerName: "Sunita Kale", ownerMobileE164: "+919811100002", ownerEmail: "sunita@test.local", otpChannel: "EMAIL", createdBy: a.user.id });

    const perf = await dealerPerformance(a.dealer.id);
    expect(perf.totals).toMatchObject({ registered: 3, activated: 1, pending: 3 });
    expect(perf.shops).toHaveLength(3);
    expect(perf.shops.every((s) => s.district === "Pune")).toBe(true);
    expect(perf.pending.map((p) => p.kind).sort()).toEqual(["OWNER_CODE", "SHOP", "SHOP"]);
    expect(perf.pending.find((p) => p.kind === "OWNER_CODE")).toMatchObject({ title: "Sunita Kale", detail: "Waiting for the owner's code" });

    const ravisRow = perf.employees.find((e) => e.name === "Ravi")!;
    expect(ravisRow).toMatchObject({ registered: 2, activated: 1, activationRate: 50, openLeads: 1 });
    expect(perf.employees.find((e) => e.name === "Asha")).toMatchObject({ registered: 0, activationRate: 0 });

    const kothrud = perf.areas.find((x) => x.areaName === "Kothrud")!;
    expect(kothrud).toMatchObject({ registered: 2, activated: 1, pending: 1, district: "Pune" });
    expect(perf.areas.find((x) => x.areaName === "Wakad / Hinjewadi")).toMatchObject({ registered: 1 });

    expect(perf.daily).toHaveLength(14);
    expect(perf.weekly).toHaveLength(12);
    expect(perf.monthly).toHaveLength(12);
    expect(perf.daily.at(-1)).toMatchObject({ registered: 2, activated: 1 });
    expect(perf.monthly.reduce((s, p) => s + p.registered, 0)).toBe(3);

    // Dealer B's board has only B's shop.
    const theirs = await dealerPerformance(b.dealer.id);
    expect(theirs.totals.registered).toBe(1);
    expect(theirs.employees).toHaveLength(0);
  });

  it("the staff overview lists every dealer with rating, shops and commission", async () => {
    const a = await dealerWith("Dealer A");
    await shopFor(a.dealer.id, { pincode: "411038", status: "APPROVED", activated: true });
    const rows = await dealersOverview();
    expect(rows.find((r) => r.id === a.dealer.id)).toMatchObject({ rating: 5.5, registeredShops: 1, activatedShops: 1, earnedPaise: 0 });
  });
});

describe("document requirements are admin-only (scenario 69)", () => {
  it("an operator cannot change them; an admin can", async () => {
    const op = await createUser({ role: "OPERATOR" });
    state.session = { user: { id: op.id, email: op.email, name: op.name, image: null, role: "OPERATOR", status: "ACTIVE" } };
    const body = { dealerType: "INDIVIDUAL", docType: "GSTIN", required: true };
    expect((await call(requirementsPut, "/api/admin/dealer-document-requirements", { method: "PUT", body })).status).toBe(403);
    state.session = { user: { id: admin.id, email: admin.email, name: admin.name, image: null, role: "ADMIN", status: "ACTIVE" } };
    const ok = await call(requirementsPut, "/api/admin/dealer-document-requirements", { method: "PUT", body });
    expect(ok.status).toBe(200);
    expect(ok.body.requirements.find((r: { dealerType: string; docType: string }) => r.dealerType === "INDIVIDUAL" && r.docType === "GSTIN").required).toBe(true);
    // Put it back (seed data is not reset between tests).
    await call(requirementsPut, "/api/admin/dealer-document-requirements", { method: "PUT", body: { ...body, required: false } });
  });
});
