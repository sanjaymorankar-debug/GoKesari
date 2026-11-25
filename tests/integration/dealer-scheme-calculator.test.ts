/**
 * Dealership & Franchise Platform phase 3 (docs/dealer-platform/PHASE_3_CALCULATOR.md):
 *   pure: one-time lines with team levels, the commission budget, monthly duration, formula components
 *   database (production scheme state, 0179):
 *     - a new free dealer is on Free v3: his shop's activation pays 20% of the fee, once (re-runs write nothing)
 *     - the month close pays him nothing more (owner D1, 25-Nov-2026: no monthly commission)
 *     - a dealer still on Free v2 gets 5% of GoKesari's commission at the month close, once
 *     - an existing dealer on Free v1 keeps the existing commission model (D8)
 *     - Growth Partner with a team: 30% to the signing agent, 4% to his lead, 3% to the dealer
 *     - a refunded registration fee reverses the scheme lines
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { schemeTermsSchema, type SchemeTerms } from "@/lib/dealer-schemes";
import { AGENT_AGREEMENT_VERSION } from "@/lib/dealer-tiers";
import { db } from "@/server/db";
import {
  dealerCommissionLedger,
  dealerCommissionMonths,
  dealers,
  dealerSalespeople,
  dealerSchemeAssignments,
  dealerSchemes,
  dealerSchemeVersions,
  orders,
  sellerVerifications,
  shopAttributions,
  shops,
} from "@/server/db/schema";
import { reverseShopCommission, setCommissionSettings } from "@/server/dealers/commission";
import { closeCommissionMonth } from "@/server/dealers/monthly-payout";
import { componentAmount, monthsBetween, oneTimeLines, recurringAmount, ZERO_BASIS } from "@/server/dealers/scheme-calculator";
import { assignSchemeVersion } from "@/server/dealers/scheme-registration";
import { addSalesperson } from "@/server/dealers/service";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { setCommissionRate } from "@/server/services/finance";
import { updateOrderStatus } from "@/server/services/orders";
import { recordPayment } from "@/server/services/shop-payments";
import { approveShop } from "@/server/services/shops";
import { createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";
import { resetSchemes } from "../helpers/schemes";

let admin: { id: string; role: "ADMIN" };

const terms = async (code: string, version = 1): Promise<SchemeTerms> => {
  const [r] = await db.select({ t: dealerSchemeVersions.terms }).from(dealerSchemeVersions).innerJoin(dealerSchemes, eq(dealerSchemes.id, dealerSchemeVersions.schemeId)).where(and(eq(dealerSchemes.code, code), eq(dealerSchemeVersions.version, version)));
  return schemeTermsSchema.parse(r.t);
};
const versionId = async (code: string, version = 1) =>
  (await db.select({ id: dealerSchemeVersions.id }).from(dealerSchemeVersions).innerJoin(dealerSchemes, eq(dealerSchemes.id, dealerSchemeVersions.schemeId)).where(and(eq(dealerSchemes.code, code), eq(dealerSchemeVersions.version, version))))[0].id;

beforeEach(async () => {
  await resetDatabase();
  await db.delete(dealerCommissionLedger);
  await db.delete(dealerCommissionMonths);
  await resetSchemes(); // production state after 0179
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await setCommissionSettings({ catalogueMinProducts: 1, branchEligible: false, commissionModel: "BASE_PERCENT", basePercentBp: 4000, ratingStepBp: 100, autoApproveAtMonthEnd: true, payoutDayOfMonth: 5 }, "test defaults", admin);
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: null }, "on (test)", admin);
  await setFeatureFlag("dealer_rating_bonus_enabled", { enabled: false, districtCodes: null }, "off (test)", admin);
  await db.execute(sql`delete from platform_settings where key in ('dealerTieredCommission', 'dealerPayouts', 'dealerPayoutTds')`);
  await setCommissionRate({ scope: "DEFAULT", rateBp: 200 }, admin);
});

async function dealer(name: string) {
  const user = await createUser({ role: "DEALER" });
  const [d] = await db.insert(dealers).values({ userId: user.id, legalName: name, contactName: name, dealerType: "PROPRIETORSHIP", status: "APPROVED", panHash: `pan-${user.id}`, bankStatus: "VERIFIED" }).returning();
  return d;
}

/** A shop registered by `dealerId` (signer: a member or the dealer), fee paid (base + 18% GST), approved → activated. */
async function signedShop(dealerId: string, signerId: string | null, basePaise: number) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const gst = Math.round(basePaise * 0.18);
  const shop = await createShop(owner.id, { name: `S ${Math.random().toString(36).slice(2, 7)}`, status: "PENDING_APPROVAL", shopType: "GENERAL_TRADING" as never, registrationFeePaise: basePaise + gst });
  await db.update(shops).set({ registrationFeeBasePaise: basePaise, registrationFeeDiscountPaise: 0, registrationFeeGstPaise: gst, phone: `9${Math.floor(100_000_000 + Math.random() * 899_999_999)}` }).where(eq(shops.id, shop.id));
  await db.insert(shopAttributions).values({ shopId: shop.id, dealerId, salespersonId: signerId, source: "CODE_AT_REGISTRATION", matchKind: "NONE" });
  await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: basePaise + gst, method: "ONLINE", transactionId: `cf_${shop.id.slice(0, 8)}` }, admin);
  for (const docType of ["PAN", "GSTIN", "SHOP_ACT"] as const) await db.insert(sellerVerifications).values({ shopId: shop.id, docType, status: "VERIFIED", providerId: "mock", verifiedAt: new Date() });
  await approveShop(shop.id, { classification: "KESARI" }, admin);
  return shop;
}

async function deliver(shopId: string, subtotalPaise: number) {
  const buyer = await createUser();
  const order = await createOrder(buyer.id, shopId, { status: "OUT_FOR_DELIVERY", subtotalPaise, paidAt: new Date() });
  await db.update(orders).set({ deliveryAddressSnapshot: { line1: "1 Buyer Road", city: "Pune", pincode: "411030" } }).where(eq(orders.id, order.id));
  await updateOrderStatus(order.id, "DELIVERED", admin);
}

const lines = async (shopId: string) =>
  (await db.select({ e: dealerCommissionLedger, name: dealerSalespeople.name }).from(dealerCommissionLedger).leftJoin(dealerSalespeople, eq(dealerSalespeople.id, dealerCommissionLedger.payeeMemberId)).where(eq(dealerCommissionLedger.shopId, shopId)))
    .map((r) => `${r.e.entryType}:${r.name ?? "DEALER"}:${r.e.amountPaise}:${r.e.status}`)
    .sort();

const thisMonth = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);

describe("calculation (pure)", () => {
  it("pays Growth Partner's team levels and keeps a non-team scheme with the dealer", async () => {
    const gp = await terms("GROWTH_PARTNER");
    const v = { ...ZERO_BASIS, shopRegistrationFeePaise: 100_000 };
    expect(oneTimeLines(gp, v, { signedByMember: true, levelsAbove: 2 }).map((l) => [l.payee, l.amountPaise])).toEqual([["SIGNER", 30_000], ["LEVEL_1", 4_000], ["LEVEL_2", 3_000]]);
    expect(oneTimeLines(gp, v, { signedByMember: true, levelsAbove: 1 }).map((l) => [l.payee, l.amountPaise])).toEqual([["SIGNER", 30_000], ["LEVEL_1", 4_000]]);
    expect(oneTimeLines(gp, v, { signedByMember: false, levelsAbove: 0 }).map((l) => [l.payee, l.amountPaise])).toEqual([["MAIN", 30_000]]);
    const bp = await terms("BUSINESS_PARTNER");
    expect(oneTimeLines(bp, v, { signedByMember: true, levelsAbove: 2 }).map((l) => [l.payee, l.amountPaise])).toEqual([["MAIN", 25_000]]);
  });

  it("scales the one-time lines down to the commission budget", async () => {
    const gp = { ...(await terms("GROWTH_PARTNER")), commissionBudgetBp: 3000 };
    const out = oneTimeLines(gp, { ...ZERO_BASIS, shopRegistrationFeePaise: 100_000 }, { signedByMember: true, levelsAbove: 2 });
    expect(out.reduce((n, l) => n + l.amountPaise, 0)).toBe(30_000);
    expect(out.every((l) => l.scaled)).toBe(true);
  });

  it("pays monthly components for their duration only; runs formulas safely", async () => {
    const free = await terms("FREE", 2);
    const monthly = free.components.find((c) => c.kind === "RECURRING")!;
    expect(recurringAmount(monthly, { ...ZERO_BASIS, platformCommissionPaise: 40_000, monthsSinceActivation: 0 })).toBe(2_000);
    expect(recurringAmount(monthly, { ...ZERO_BASIS, platformCommissionPaise: 40_000, monthsSinceActivation: 11 })).toBe(2_000);
    expect(recurringAmount(monthly, { ...ZERO_BASIS, platformCommissionPaise: 40_000, monthsSinceActivation: 12 })).toBe(0);
    const formula = { ...monthly, basis: "FORMULA" as const, rateBp: undefined, formula: "IF(shopsThisMonth >= 50, PERCENT(platformCommissionPaise, 700), PERCENT(platformCommissionPaise, 500))" };
    expect(componentAmount(formula, { ...ZERO_BASIS, platformCommissionPaise: 10_000, shopsThisMonth: 50 })).toBe(700);
    expect(componentAmount(formula, { ...ZERO_BASIS, platformCommissionPaise: 10_000, shopsThisMonth: 3 })).toBe(500);
    expect(() => componentAmount({ ...formula, formula: "process.exit()" }, ZERO_BASIS)).toThrow();
    expect(monthsBetween(new Date("2026-11-30T20:00:00Z"), "2026-12")).toBe(0); // 1 Dec IST
  });
});

describe("calculation (database)", () => {
  it("Free v3: 20% at activation once, no monthly commission at the month close (D1, 25-Nov-2026)", async () => {
    const d = await dealer("Free Three");
    const [a] = await db.select().from(dealerSchemeAssignments).where(eq(dealerSchemeAssignments.dealerId, d.id));
    expect(a.versionId).toBe(await versionId("FREE", 3));
    const shop = await signedShop(d.id, null, 100_000);
    expect(await lines(shop.id)).toEqual(["SCHEME_ONE_TIME:DEALER:20000:EARNED"]);
    // A re-run (another milestone check) writes nothing new.
    await (await import("@/server/dealers/commission")).checkCommissionMilestones(shop.id, null);
    expect(await lines(shop.id)).toHaveLength(1);

    await deliver(shop.id, 500_000); // ₹5,000 delivered; GoKesari's 2% = ₹100
    const month = thisMonth();
    await db.transaction(async (tx) => {
      const { accrueSchemeRecurring } = await import("@/server/dealers/scheme-calculator");
      const { start, end } = { start: new Date(`${month}-01T00:00:00+05:30`), end: new Date(new Date(`${month}-01T00:00:00+05:30`).setUTCMonth(new Date(`${month}-01T00:00:00+05:30`).getUTCMonth() + 1)) };
      await accrueSchemeRecurring(tx, month, start, end, null);
      await accrueSchemeRecurring(tx, month, start, end, null); // idempotent
    });
    const all = await lines(shop.id);
    expect(all).toEqual(["SCHEME_ONE_TIME:DEALER:20000:EARNED"]);
  });

  it("Free v2: 20% at activation once, then 5% of GoKesari's commission at the month close", async () => {
    await resetSchemes(undefined, { freeVersion: 2 }); // a dealer who joined on v2
    const d = await dealer("Free Two");
    const [a] = await db.select().from(dealerSchemeAssignments).where(eq(dealerSchemeAssignments.dealerId, d.id));
    expect(a.versionId).toBe(await versionId("FREE", 2));
    const shop = await signedShop(d.id, null, 100_000);
    expect(await lines(shop.id)).toEqual(["SCHEME_ONE_TIME:DEALER:20000:EARNED"]);
    // A re-run (another milestone check) writes nothing new.
    await (await import("@/server/dealers/commission")).checkCommissionMilestones(shop.id, null);
    expect(await lines(shop.id)).toHaveLength(1);

    await deliver(shop.id, 500_000); // ₹5,000 delivered; GoKesari's 2% = ₹100
    const month = thisMonth();
    await db.transaction(async (tx) => {
      const { accrueSchemeRecurring } = await import("@/server/dealers/scheme-calculator");
      const { start, end } = { start: new Date(`${month}-01T00:00:00+05:30`), end: new Date(new Date(`${month}-01T00:00:00+05:30`).setUTCMonth(new Date(`${month}-01T00:00:00+05:30`).getUTCMonth() + 1)) };
      await accrueSchemeRecurring(tx, month, start, end, null);
      await accrueSchemeRecurring(tx, month, start, end, null); // idempotent
    });
    const all = await lines(shop.id);
    expect(all).toContain("SCHEME_RECURRING:DEALER:500:EARNED");
    expect(all).toHaveLength(2);
  });

  it("an existing dealer on Free v1 keeps the existing commission model (D8)", async () => {
    await resetSchemes(["FREE"], { freeVersion: 1 });
    const d = await dealer("Old Terms");
    await resetSchemes(); // GoKesari publishes a newer version afterwards
    const shop = await signedShop(d.id, null, 100_000);
    expect(await lines(shop.id)).toEqual(["BASE:DEALER:40000:EARNED"]); // 40% base model, unchanged
  });

  it("Growth Partner with a team: 30% to the agent, 4% to his lead, 3% to the dealer", async () => {
    const d = await dealer("Growth Co");
    await db.transaction(async (tx) => assignSchemeVersion(d.id, await versionId("GROWTH_PARTNER"), "UPGRADE", "test upgrade", admin.id, tx));
    const lead = await addSalesperson(d.id, { employeeId: "LEAD1", name: "Lead One", role: "TEAM_LEAD", parentId: null }, admin);
    const agent = await addSalesperson(d.id, { employeeId: "AGENT1", name: "Agent One", role: "AGENT", parentId: lead.id }, admin);
    await db.update(dealerSalespeople).set({ agreementVersion: AGENT_AGREEMENT_VERSION, agreementAcceptedAt: new Date() }).where(eq(dealerSalespeople.dealerId, d.id));
    const shop = await signedShop(d.id, agent.id, 100_000);
    expect(await lines(shop.id)).toEqual(["SCHEME_ONE_TIME:Agent One:30000:EARNED", "SCHEME_TEAM:DEALER:3000:EARNED", "SCHEME_TEAM:Lead One:4000:EARNED"]);
  });

  it("reverses scheme lines when the registration fee is refunded", async () => {
    const d = await dealer("Refund Co");
    const shop = await signedShop(d.id, null, 100_000);
    await reverseShopCommission(shop.id, "fee refunded (test)", admin);
    expect(await lines(shop.id)).toEqual(["SCHEME_ONE_TIME:DEALER:20000:REVERSED"]);
  });

  it("closes a month with scheme lines approved and drafted for payout", async () => {
    await resetSchemes(undefined, { freeVersion: 2 }); // a dealer on v2, which has a monthly component
    const d = await dealer("Close Co");
    const shop = await signedShop(d.id, null, 100_000);
    await deliver(shop.id, 500_000);
    const month = thisMonth();
    const next = new Date(`${month}-01T00:00:00+05:30`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const result = await closeCommissionMonth(month, admin, new Date(next.getTime() + 60_000));
    expect(result).not.toBeNull();
    expect((await lines(shop.id)).sort()).toEqual(["SCHEME_ONE_TIME:DEALER:20000:APPROVED", "SCHEME_RECURRING:DEALER:500:APPROVED"]);
  });
});
