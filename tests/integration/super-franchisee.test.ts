/**
 * Super franchisee (owner, 27-Nov-2026; docs/super-franchisee/README.md; migration 0226).
 *   - only an admin promotes a dealer and assigns / moves / removes the dealers of his team
 *   - a team dealer's shop fee pays the super franchisee 3% EXTRA (the dealer's own commission is unchanged), once
 *   - the month close pays him 2% of GoKesari's order commission on his team's shops, once
 *   - own team only: another super franchisee's team earns him nothing
 *   - a move: fees from then go to the new team; the month's orders to the team at the month end
 *   - his own rates override the rule; rule off = nothing earned
 *   - a refunded shop fee reverses his line; backdated assignment credits fees paid shortly before
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { dealerCodes, dealerCommissionLedger, dealerCommissionMonths, dealers, notifications, referralCodes, orders, sellerVerifications, shopAttributions, shops, superFranchiseeMembers, superFranchisees } from "@/server/db/schema";
import { reverseShopCommission, setCommissionSettings } from "@/server/dealers/commission";
import {
  accrueSuperFranchiseeMonth,
  assignToSuperFranchisee,
  promoteSuperFranchisee,
  removeFromTeam,
  removeSuperFranchisee,
  setSuperFranchiseeRates,
  shareOf,
  superFranchiseeView,
} from "@/server/dealers/super-franchisee";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { setCommissionRate } from "@/server/services/finance";
import { updateOrderStatus } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { recordPayment } from "@/server/services/shop-payments";
import { approveShop } from "@/server/services/shops";
import { createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";
import { resetSchemes } from "../helpers/schemes";

let admin: { id: string; role: "ADMIN" };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(superFranchiseeMembers);
  await db.delete(superFranchisees);
  await db.delete(dealerCommissionLedger);
  await db.delete(dealerCommissionMonths);
  await resetSchemes();
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await setCommissionSettings({ catalogueMinProducts: 1, branchEligible: false, commissionModel: "BASE_PERCENT", basePercentBp: 4000, ratingStepBp: 100, autoApproveAtMonthEnd: true, payoutDayOfMonth: 5 }, "test defaults", admin);
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: null }, "on (test)", admin);
  await setFeatureFlag("dealer_rating_bonus_enabled", { enabled: false, districtCodes: null }, "off (test)", admin);
  await db.execute(sql`delete from platform_settings where key in ('superFranchisee', 'dealerTieredCommission', 'dealerPayouts', 'dealerPayoutTds')`);
  clearRuleCache();
  await setRule("superFranchisee", { enabled: true }, admin);
  await setCommissionRate({ scope: "DEFAULT", rateBp: 200 }, admin);
});

async function dealer(name: string) {
  const user = await createUser({ role: "DEALER" });
  const [d] = await db.insert(dealers).values({ userId: user.id, legalName: name, contactName: name, dealerType: "PROPRIETORSHIP", status: "APPROVED", panHash: `pan-${user.id}`, bankStatus: "VERIFIED" }).returning();
  return d;
}

/** A shop registered by `dealerId`, fee paid (base + 18% GST), approved → activated. */
async function signedShop(dealerId: string, basePaise: number) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const gst = Math.round(basePaise * 0.18);
  const shop = await createShop(owner.id, { name: `S ${Math.random().toString(36).slice(2, 7)}`, status: "PENDING_APPROVAL", shopType: "GENERAL_TRADING" as never, registrationFeePaise: basePaise + gst });
  await db.update(shops).set({ registrationFeeBasePaise: basePaise, registrationFeeDiscountPaise: 0, registrationFeeGstPaise: gst, phone: `9${Math.floor(100_000_000 + Math.random() * 899_999_999)}` }).where(eq(shops.id, shop.id));
  await db.insert(shopAttributions).values({ shopId: shop.id, dealerId, salespersonId: null, source: "CODE_AT_REGISTRATION", matchKind: "NONE" });
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

const superLines = async (dealerId: string) =>
  (await db.select().from(dealerCommissionLedger).where(and(eq(dealerCommissionLedger.dealerId, dealerId), sql`${dealerCommissionLedger.entryType} in ('SUPER_FEE', 'SUPER_ORDER')`)))
    .map((e) => `${e.entryType}:${e.amountPaise}:${e.status}`)
    .sort();

const thisMonth = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
async function closeMonthOrders() {
  const month = thisMonth();
  const start = new Date(`${month}-01T00:00:00+05:30`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  await db.transaction(async (tx) => {
    await accrueSuperFranchiseeMonth(tx, month, start, end, null);
    await accrueSuperFranchiseeMonth(tx, month, start, end, null); // idempotent
  });
}

describe("super franchisee", () => {
  it("rounds the share", () => {
    expect(shareOf(100_000, 300)).toBe(3_000);
    expect(shareOf(10_000, 200)).toBe(200);
    expect(shareOf(0, 300)).toBe(0);
    expect(shareOf(100_000, 0)).toBe(0);
  });

  it("only an admin promotes and assigns", async () => {
    const s = await dealer("Deepak");
    const m = await dealer("Dolke");
    const operator = { id: (await createUser({ role: "OPERATOR" })).id, role: "OPERATOR" as const };
    await expect(promoteSuperFranchisee(s.id, { reason: "owner decision" }, operator)).rejects.toThrow(/admin/i);
    await promoteSuperFranchisee(s.id, { reason: "owner decision" }, admin);
    await expect(assignToSuperFranchisee(s.id, m.id, { reason: "his reference" }, operator)).rejects.toThrow(/admin/i);
    await expect(promoteSuperFranchisee(s.id, { reason: "x" }, admin)).rejects.toThrow(/say why/i);
  });

  it("pays 3% of a team shop's fee and 2% of GoKesari's order commission, extra, once, own team only", async () => {
    const deepak = await dealer("Deepak");
    const sanjay = await dealer("Sanjay");
    const dolke = await dealer("Dolke");
    const other = await dealer("Other");
    await promoteSuperFranchisee(deepak.id, { reason: "owner decision" }, admin);
    await promoteSuperFranchisee(sanjay.id, { reason: "owner decision" }, admin);
    await assignToSuperFranchisee(deepak.id, dolke.id, { reason: "his reference" }, admin);
    await assignToSuperFranchisee(sanjay.id, other.id, { reason: "his reference" }, admin);

    const shop = await signedShop(dolke.id, 100_000); // ₹1,000 before GST
    expect(await superLines(deepak.id)).toEqual(["SUPER_FEE:3000:EARNED"]);
    expect(await superLines(sanjay.id)).toEqual([]);
    // Dolke's own commission is untouched by Deepak's share.
    const own = await db.select().from(dealerCommissionLedger).where(and(eq(dealerCommissionLedger.dealerId, dolke.id), eq(dealerCommissionLedger.shopId, shop.id)));
    expect(own.length).toBeGreaterThan(0);
    // Another milestone check writes nothing new.
    await (await import("@/server/dealers/commission")).checkCommissionMilestones(shop.id, null);
    expect(await superLines(deepak.id)).toHaveLength(1);

    await deliver(shop.id, 500_000); // ₹5,000; GoKesari's 2% = ₹100 → Deepak 2% of that = ₹2
    await closeMonthOrders();
    expect(await superLines(deepak.id)).toEqual(["SUPER_FEE:3000:EARNED", "SUPER_ORDER:200:EARNED"]);
    expect(await superLines(sanjay.id)).toEqual([]);

    const view = await superFranchiseeView(deepak.id);
    expect(view.team.map((t) => t.name)).toEqual(["Dolke"]);
    expect(view.earnedPaise).toEqual({ fees: 3000, orders: 200 });
    expect((await superFranchiseeView(dolke.id)).memberOf?.name).toBe("Deepak");
  });

  it("moves: new fees go to the new team, the month's orders to the team at the month end", async () => {
    const deepak = await dealer("Deepak");
    const sanjay = await dealer("Sanjay");
    const dolke = await dealer("Dolke");
    await promoteSuperFranchisee(deepak.id, { reason: "owner decision" }, admin);
    await promoteSuperFranchisee(sanjay.id, { reason: "owner decision" }, admin);
    await assignToSuperFranchisee(deepak.id, dolke.id, { reason: "his reference" }, admin);
    const first = await signedShop(dolke.id, 100_000);
    await assignToSuperFranchisee(sanjay.id, dolke.id, { reason: "moved by the owner" }, admin);
    await signedShop(dolke.id, 200_000);
    expect(await superLines(deepak.id)).toEqual(["SUPER_FEE:3000:EARNED"]);
    expect(await superLines(sanjay.id)).toEqual(["SUPER_FEE:6000:EARNED"]);
    await deliver(first.id, 500_000);
    await closeMonthOrders();
    expect(await superLines(sanjay.id)).toContain("SUPER_ORDER:200:EARNED");
    expect(await superLines(deepak.id)).not.toContain("SUPER_ORDER:200:EARNED");
    // One open link per dealer; history kept.
    const links = await db.select().from(superFranchiseeMembers).where(eq(superFranchiseeMembers.memberDealerId, dolke.id));
    expect(links).toHaveLength(2);
    expect(links.filter((l) => l.endsAt === null)).toHaveLength(1);
  });

  it("own rates override the rule; rule off earns nothing; removal releases the team", async () => {
    const deepak = await dealer("Deepak");
    const dolke = await dealer("Dolke");
    await promoteSuperFranchisee(deepak.id, { reason: "owner decision", feeShareBp: 500 }, admin);
    await assignToSuperFranchisee(deepak.id, dolke.id, { reason: "his reference" }, admin);
    await signedShop(dolke.id, 100_000);
    expect(await superLines(deepak.id)).toEqual(["SUPER_FEE:5000:EARNED"]);
    await setSuperFranchiseeRates(deepak.id, { reason: "back to default", feeShareBp: null, orderShareBp: null }, admin);
    await setRule("superFranchisee", { enabled: false }, admin);
    await signedShop(dolke.id, 100_000);
    expect(await superLines(deepak.id)).toHaveLength(1);
    await setRule("superFranchisee", { enabled: true }, admin);
    await removeSuperFranchisee(deepak.id, "owner decision", admin);
    expect((await superFranchiseeView(dolke.id)).memberOf).toBeNull();
    await signedShop(dolke.id, 100_000);
    expect(await superLines(deepak.id)).toHaveLength(1);
  });

  it("reverses on a refunded fee; backdated assignment credits fees paid shortly before", async () => {
    const deepak = await dealer("Deepak");
    const dolke = await dealer("Dolke");
    await promoteSuperFranchisee(deepak.id, { reason: "owner decision" }, admin);
    const before = await signedShop(dolke.id, 100_000); // paid before Dolke joined the team
    await assignToSuperFranchisee(deepak.id, dolke.id, { reason: "his reference" }, admin);
    expect(await superLines(deepak.id)).toEqual([]);
    await removeFromTeam(dolke.id, "redo with backdating", admin);
    await assignToSuperFranchisee(deepak.id, dolke.id, { reason: "his reference, with the last month", backdateDays: 30 }, admin);
    expect(await superLines(deepak.id)).toEqual(["SUPER_FEE:3000:EARNED"]);
    await reverseShopCommission(before.id, "fee refunded", admin);
    expect(await superLines(deepak.id)).toEqual(["SUPER_FEE:3000:REVERSED"]);
  });

  it("refuses a super franchisee in another team, and a dealer in his own team", async () => {
    const deepak = await dealer("Deepak");
    const sanjay = await dealer("Sanjay");
    await promoteSuperFranchisee(deepak.id, { reason: "owner decision" }, admin);
    await promoteSuperFranchisee(sanjay.id, { reason: "owner decision" }, admin);
    await expect(assignToSuperFranchisee(deepak.id, sanjay.id, { reason: "not allowed" }, admin)).rejects.toThrow(/super franchisee/i);
    await expect(assignToSuperFranchisee(deepak.id, deepak.id, { reason: "not allowed" }, admin)).rejects.toThrow(/own team/i);
  });

  it("reports: the team and its shops by name; the monthly report once, on the 1st, for last month; the super hears of a new team shop", async () => {
    const { previousMonth, sendMonthlyReports, superTeamLines } = await import("@/server/dealers/report-extras");
    expect(previousMonth(new Date("2026-12-01T00:00:00Z")).month).toBe("2026-11"); // 05:30 IST, 1 Dec
    expect(previousMonth(new Date("2027-01-01T00:00:00Z")).month).toBe("2026-12");

    const deepak = await dealer("Deepak");
    const dolke = await dealer("Dolke");
    await promoteSuperFranchisee(deepak.id, { reason: "owner decision" }, admin);
    await assignToSuperFranchisee(deepak.id, dolke.id, { reason: "his reference" }, admin);
    const shop = await signedShop(dolke.id, 100_000);
    const from = new Date(Date.now() - 86_400_000);
    const to = new Date(Date.now() + 60_000);
    const team = await superTeamLines(deepak.id, from, to);
    expect(team.active).toBe(true);
    expect(team.lines.map((l) => `${l.label}|${l.value}`).join("\n")).toMatch(/Team: Dolke\|1 shops live/);
    expect(team.lines.some((l) => l.value.startsWith(shop.name))).toBe(true);
    expect(team.lines.find((l) => l.label === "Your super franchisee share")?.value).toBe("₹30.00");

    // The 1st of next month (IST), 05:00 IST: the report for this month.
    const ist = new Date(Date.now() + 330 * 60_000);
    const first = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 1) - 30 * 60_000); // 23:30 UTC = 05:00 IST on the 1st
    expect(await sendMonthlyReports(new Date(first.getTime() + 2 * 86_400_000))).toEqual({ skipped: "not the 1st" });
    expect(await sendMonthlyReports(first)).toMatchObject({ sent: 2 });
    const rows = await db.select().from(notifications).where(and(eq(notifications.type, "dealer.team_report"), eq(notifications.channel, "IN_APP")));
    expect(rows.find((n) => n.userId === dolke.userId)?.title).toMatch(/^Monthly team report: 1 registered, ₹/);
    await sendMonthlyReports(first); // a re-run sends nothing new
    expect(await db.select().from(notifications).where(and(eq(notifications.type, "dealer.team_report"), eq(notifications.channel, "IN_APP")))).toHaveLength(rows.length);
  });

  it("tells the super franchisee when a shop registers with a team dealer's code", async () => {
    const deepak = await dealer("Deepak");
    const dolke = await dealer("Dolke");
    await promoteSuperFranchisee(deepak.id, { reason: "owner decision" }, admin);
    await assignToSuperFranchisee(deepak.id, dolke.id, { reason: "his reference" }, admin);
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { name: "Team Kirana", status: "PENDING_APPROVAL", shopType: "GENERAL_TRADING" as never });
    // Dolke's dealer code, and the shop registered with it.
    const [rc] = await db.insert(referralCodes).values({ code: `GKD-T${Math.random().toString(36).slice(2, 7).toUpperCase()}`, createdBy: admin.id }).returning();
    await db.insert(dealerCodes).values({ referralCodeId: rc.id, dealerId: dolke.id, kind: "DEALER" });
    await db.update(shops).set({ referralCodeId: rc.id }).where(eq(shops.id, shop.id));
    const { recordShopAttribution } = await import("@/server/dealers/attribution");
    await recordShopAttribution(shop.id, admin);
    const notes = await db.select().from(notifications).where(and(eq(notifications.userId, deepak.userId!), eq(notifications.channel, "IN_APP")));
    expect(notes.map((n) => n.title)).toContain("New shop in your team: Team Kirana");
    const dolkeNotes = await db.select().from(notifications).where(and(eq(notifications.userId, dolke.userId!), eq(notifications.type, "dealer.shop_attributed"), eq(notifications.channel, "IN_APP")));
    expect(dolkeNotes).toHaveLength(1);
  });
});
