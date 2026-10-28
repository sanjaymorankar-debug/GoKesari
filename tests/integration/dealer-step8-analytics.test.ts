/**
 * Dealer programme step 8 (docs/dealer-programme): P1 analytics.
 * GKS-GEO-001 coverage — dealers, shops, target vs registered, not operational, gaps;
 * GKS-AN-001 performance score — admin-set weights, compared within the district;
 * GKS-AN-002 activation and 30-day order activity per dealer and employee.
 * Read: admin and operator; targets: admin only; programme off → 404.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { GET as analyticsGet, POST as analyticsPost } from "@/app/api/admin/dealer-analytics/route";
import { db } from "@/server/db";
import { dealerCommissionLedger, dealers, dealerSalespeople, dealerTerritories, geoAreaTargets, shopAttributions, shops } from "@/server/db/schema";
import { activationReport, coverageReport, dealerScores, setAreaTarget } from "@/server/dealers/analytics";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { resetRule, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

type Actor = { id: string; email: string; name: string | null; role: UserRole };
let admin: Actor;
let customer: Actor;

const signIn = (u: Actor) => {
  state.session = { user: { id: u.id, email: u.email, name: u.name, image: null, role: u.role, status: "ACTIVE" } };
};

async function dealerWith(name: string, pincode = "411038") {
  const user = await createUser({ role: "DEALER" });
  const [dealer] = await db.insert(dealers).values({ userId: user.id, legalName: name, contactName: name, dealerType: "PROPRIETORSHIP", status: "APPROVED", pincode }).returning();
  return dealer;
}

/** A shop in a PIN, optionally live, brought by a dealer, with orders in the last 30 days. */
async function shopAt(pincode: string, opts: { live?: boolean; dealerId?: string; salespersonId?: string | null; orders?: number; duplicate?: boolean; lat?: number; lng?: number } = {}) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: `Shop ${pincode} ${Math.random().toString(36).slice(2, 6)}`, status: opts.live ? "APPROVED" : "PENDING_APPROVAL", shopType: "GENERAL_TRADING" as never });
  await db
    .update(shops)
    .set({ pincode, lifecycleStatus: opts.live ? "ACTIVE" : "KYC_PENDING", latitude: opts.lat ?? null, longitude: opts.lng ?? null } as never)
    .where(eq(shops.id, shop.id));
  if (opts.dealerId) {
    await db.insert(shopAttributions).values({
      shopId: shop.id,
      dealerId: opts.dealerId,
      salespersonId: opts.salespersonId ?? null,
      source: "CODE_AT_REGISTRATION",
      matchKind: opts.duplicate ? "DUPLICATE" : "NONE",
      activatedAt: opts.live ? new Date() : null,
      createdAt: new Date(Date.now() - 4 * 86_400_000),
    });
  }
  for (let i = 0; i < (opts.orders ?? 0); i++) await createOrder(customer.id, shop.id, { status: "DELIVERED" });
  return shop;
}

beforeEach(async () => {
  await resetDatabase();
  await db.delete(geoAreaTargets);
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, email: a.email, name: a.name, role: "ADMIN" };
  const c = await createUser({ role: "CUSTOMER" });
  customer = { id: c.id, email: c.email, name: c.name, role: "CUSTOMER" };
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: null }, "dealer programme (test)", admin);
  await resetRule("dealerPerformanceScore", admin);
});

describe("coverage (GKS-GEO-001)", () => {
  it("counts dealers, shops, operational shops and targets per area; flags the gaps", async () => {
    const a = await dealerWith("Dealer A");
    await db.insert(dealerTerritories).values({ dealerId: a.id, areaCode: "MH-PUN-PMC" });
    await shopAt("411038", { live: true, dealerId: a.id, orders: 2, lat: 18.507, lng: 73.807 });
    await shopAt("411038", { dealerId: a.id });
    await shopAt("411057", { live: true, lat: 18.598, lng: 73.765 });
    await setAreaTarget("MH-PUN-PCMC-WAKAD", 3, "pilot target", admin);

    const rows = await coverageReport("MH-PUN");
    const by = (code: string) => rows.find((r) => r.code === code)!;
    expect(by("MH-PUN")).toMatchObject({ shops: 3, dealerShops: 2, operational: 1, activeDealers: 1 });
    // Kothrud: the dealer's territory (Pune City) is above it; one of two shops takes orders.
    expect(by("MH-PUN-PMC-KOTHRUD")).toMatchObject({ activeDealers: 1, shops: 2, operational: 1, notOperational: 1, status: "NOT_OPERATIONAL" });
    expect(by("MH-PUN-PMC-KOTHRUD").latitude).toBeCloseTo(18.507, 3);
    // Wakad: no dealer covers Pimpri-Chinchwad.
    expect(by("MH-PUN-PCMC-WAKAD")).toMatchObject({ activeDealers: 0, shops: 1, target: 3, status: "NO_DEALER" });

    await db.insert(dealerTerritories).values({ dealerId: a.id, areaCode: "MH-PUN-PCMC" });
    expect((await coverageReport("MH-PUN")).find((r) => r.code === "MH-PUN-PCMC-WAKAD")).toMatchObject({ activeDealers: 1, status: "UNDER_TARGET" });
    await setAreaTarget("MH-PUN-PCMC-WAKAD", 1, "", admin);
    expect((await coverageReport("MH-PUN")).find((r) => r.code === "MH-PUN-PCMC-WAKAD")?.status).toBe("NOT_OPERATIONAL");
    await setAreaTarget("MH-PUN-PCMC-WAKAD", null, "", admin);
    expect((await coverageReport("MH-PUN")).find((r) => r.code === "MH-PUN-PCMC-WAKAD")?.target).toBeNull();
  });

  it("only an admin sets targets", async () => {
    const op = await createUser({ role: "OPERATOR" });
    await expect(setAreaTarget("MH-PUN", 10, "", { id: op.id, role: "OPERATOR" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setAreaTarget("MH-NOPE", 10, "", admin)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("performance score (GKS-AN-001)", () => {
  it("weights the five parts and ranks dealers within their district", async () => {
    const a = await dealerWith("Dealer A");
    const b = await dealerWith("Dealer B");
    // Only Pune's district PIN codes are seeded: a Nashik dealer is compared within its state.
    const other = await dealerWith("Nashik Dealer", "422001");
    await db.insert(dealerTerritories).values([
      { dealerId: a.id, areaCode: "MH-PUN-PMC-KOTHRUD" },
      { dealerId: b.id, areaCode: "MH-PUN-PCMC-WAKAD" },
    ]);
    const a1 = await shopAt("411038", { live: true, dealerId: a.id, orders: 1 });
    const a2 = await shopAt("411038", { live: true, dealerId: a.id });
    const b1 = await shopAt("411038", { live: true, dealerId: b.id, orders: 1 });
    await shopAt("411057", { dealerId: b.id, duplicate: true });
    await db.insert(dealerCommissionLedger).values([
      { dealerId: a.id, shopId: a1.id, milestone: "ACTIVATED", amountPaise: 20_000 },
      { dealerId: a.id, shopId: a2.id, milestone: "ACTIVATED", amountPaise: 20_000 },
      { dealerId: b.id, shopId: b1.id, milestone: "ACTIVATED", amountPaise: 10_000 },
    ] as never);

    const { weights, rows } = await dealerScores();
    expect(weights).toEqual({ activatedShops: 35, registrationQuality: 20, activity30: 20, costPerActivatedShop: 15, coverage: 10 });
    const rowA = rows.find((r) => r.dealerId === a.id)!;
    const rowB = rows.find((r) => r.dealerId === b.id)!;
    expect(rowA).toMatchObject({ peerGroup: "Pune", peers: 2, components: { activatedShops: 1, registrationQuality: 1, activity30: 0.5, costPerActivatedShop: 0.5, coverage: 1 } });
    // 35 + 20 + 10 + 7.5 + 10
    expect(rowA.score).toBe(82.5);
    // B: 1 of A's 2 live shops, 1 of 2 registrations a duplicate, its one live shop orders, cheapest, but its live shop is outside its territory.
    expect(rowB.components).toEqual({ activatedShops: 0.5, registrationQuality: 0.5, activity30: 1, costPerActivatedShop: 1, coverage: 0 });
    expect(rowB.score).toBe(17.5 + 10 + 20 + 15);
    expect([rowA.rank, rowB.rank]).toEqual([1, 2]);
    expect(rowA.facts.costPerActivatedPaise).toBe(20_000);
    // A dealer outside Pune is compared only with dealers in its own group.
    expect(rows.find((r) => r.dealerId === other.id)).toMatchObject({ peerGroup: "Maharashtra", peers: 1, rank: 1 });

    // Admin-set weights change the score (they must add up to 100).
    await expect(setRule("dealerPerformanceScore", { activatedShops: 90 }, admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await setRule("dealerPerformanceScore", { activatedShops: 100, registrationQuality: 0, activity30: 0, costPerActivatedShop: 0, coverage: 0 }, admin);
    const again = await dealerScores();
    expect(again.rows.find((r) => r.dealerId === b.id)?.score).toBe(50);
  });
});

describe("activation and 30-day activity (GKS-AN-002)", () => {
  it("per dealer and per employee", async () => {
    const a = await dealerWith("Dealer A");
    const [ravi] = await db.insert(dealerSalespeople).values({ dealerId: a.id, employeeId: "E1", name: "Ravi" }).returning();
    await shopAt("411038", { live: true, dealerId: a.id, salespersonId: ravi.id, orders: 3 });
    await shopAt("411038", { live: true, dealerId: a.id, salespersonId: ravi.id });
    await shopAt("411038", { dealerId: a.id });
    const rows = await activationReport(a.id);
    expect(rows[0]).toMatchObject({ salespersonId: null, registered: 3, activated: 2, activationRate: 67, active30: 1, activityRate: 50, orders30: 3, avgDaysToActivate: 4 });
    expect(rows.find((r) => r.salespersonId === ravi.id)).toMatchObject({ salespersonName: "Ravi (E1)", registered: 2, activated: 2, active30: 1, orders30: 3 });
    expect(rows.find((r) => r.salespersonId === "-")).toMatchObject({ salespersonName: "No employee named", registered: 1, activated: 0 });
  });
});

describe("access", () => {
  it("admin and operator read; only admin sets targets; others 403; programme off → 404", async () => {
    const op = await createUser({ role: "OPERATOR" });
    signIn({ id: op.id, email: op.email, name: op.name, role: "OPERATOR" });
    expect((await call(analyticsGet, "/api/admin/dealer-analytics?area=MH-PUN")).status).toBe(200);
    expect((await call(analyticsPost, "/api/admin/dealer-analytics", { method: "POST", body: { areaCode: "MH-PUN", targetShops: 5 } })).status).toBe(403);
    signIn(customer);
    expect((await call(analyticsGet, "/api/admin/dealer-analytics")).status).toBe(403);
    signIn(admin);
    expect((await call(analyticsPost, "/api/admin/dealer-analytics", { method: "POST", body: { areaCode: "MH-PUN", targetShops: 5 } })).status).toBe(200);
    const ok = await call(analyticsGet, "/api/admin/dealer-analytics?area=MH-PUN");
    expect(ok.body.coverage.find((r: { code: string }) => r.code === "MH-PUN").target).toBe(5);
    await setFeatureFlag("dealer_programme_enabled", { enabled: false, districtCodes: null }, "switch off (test)", admin);
    expect((await call(analyticsGet, "/api/admin/dealer-analytics")).status).toBe(404);
  });
});
