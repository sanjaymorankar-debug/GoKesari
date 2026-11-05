/**
 * TIERED dealer commission (owner brief, 2 Nov 2026; docs/dealer-programme/TIERED_COMMISSION.md),
 * against real PostgreSQL — runs on both layouts (CI job test-split):
 *   - the network: at most 3 levels, a 4th refused by the service and the database
 *   - per shop on the fee slabs (₹999 / ₹4,999 / ₹9,999 before GST): direct 20%, 60% at
 *     ACTIVATED, the rest and the 5% / 3% overrides at TRADING; missing levels not paid
 *   - TRADING lapse; promotion with the agents he recruited and the development bonus
 *   - renewal commission; reversal of every level with negative carry-forward
 *   - the agent agreement hold; payouts per payee with PAN + verified bank; TDS on and off
 *   - monthly close per payee with target bonuses; standard dealers unchanged
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { AGENT_AGREEMENT_VERSION } from "@/lib/dealer-tiers";
import { db } from "@/server/db";
import {
  commissionTdsRates,
  dealerAgreementAcceptances,
  dealerCommissionLedger,
  dealerCommissionMonths,
  dealerPayoutBatches,
  dealerSalespeople,
  dealerTeamDevelopments,
  dealerTierShopPlans,
  dealers,
  orders,
  sellerVerifications,
  shopAttributions,
  shops,
  type DealerSalesperson,
} from "@/server/db/schema";
import { approveEntries, checkCommissionMilestones, createPayoutBatch, markPayoutPaid, setCommissionSettings } from "@/server/dealers/commission";
import { closeCommissionMonth } from "@/server/dealers/monthly-payout";
import { addSalesperson } from "@/server/dealers/service";
import {
  AGENT_AGREEMENT_SHA256,
  acceptAgentAgreement,
  checkTradingMilestone,
  mappingHistory,
  memberShops,
  setMemberPlacement,
  teamMapping,
  teamMappingCsv,
  earningsByType,
  promoteToTeamLead,
  runTieredDaily,
  setDealerCommissionModel,
  teamTree,
  tradingProgress,
} from "@/server/dealers/tiered";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { updateOrderStatus } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { recordPayment } from "@/server/services/shop-payments";
import { approveShop } from "@/server/services/shops";
import { RULES, type RuleValue } from "@/server/config/rules";
import { createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

let admin: { id: string; role: "ADMIN" };

/**
 * Most tests below run the rule with a trading condition (20 / 5 / 3, 60% at activation, the rest at
 * 2 delivered orders, no monthly minimum for the development bonus), which stays configurable. The
 * owner's structure of 5 Nov 2026 — the rule's defaults — is tested in its own block (`ownerStructure`).
 */
async function tiered(over: Partial<RuleValue<"dealerTieredCommission">> = {}) {
  await setRule(
    "dealerTieredCommission",
    { ...RULES.dealerTieredCommission.defaults, enabled: true, leadOverrideBp: 500, mainOverrideBp: 300, firstPartBp: 6000, tradingOrders: 2, developmentMinShopsPerMonth: 0, ...over },
    admin,
  );
  clearRuleCache();
}

/** The rule's defaults: the owner's structure of 5 Nov 2026. */
async function ownerStructure(over: Partial<RuleValue<"dealerTieredCommission">> = {}) {
  await setRule("dealerTieredCommission", { ...RULES.dealerTieredCommission.defaults, enabled: true, ...over }, admin);
  clearRuleCache();
}

/** Closes the current month (as on the 2nd of the next one). */
async function closeThisMonth() {
  const month = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
  const after = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 2));
  return closeCommissionMonth(month, admin, after);
}

beforeEach(async () => {
  await resetDatabase();
  await db.delete(dealerCommissionLedger);
  await db.delete(dealerCommissionMonths);
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await setCommissionSettings(
    { catalogueMinProducts: 1, branchEligible: false, commissionModel: "BASE_PERCENT", basePercentBp: 4000, ratingStepBp: 100, autoApproveAtMonthEnd: true, payoutDayOfMonth: 5 },
    "test defaults",
    admin,
  );
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", admin);
  await setFeatureFlag("dealer_rating_bonus_enabled", { enabled: false, districtCodes: null }, "off (test)", admin);
  for (const key of ["dealerTieredCommission", "dealerPayoutTds", "dealerPayouts", "dealerAutoPayout"]) await db.execute(sql`delete from platform_settings where key = ${key}`);
  // The seeded TDS rows as migration 0141 left them (a test may change them).
  await db.execute(sql`delete from commission_tds_rates where effective_from <> date '2026-04-01'`);
  await db.execute(sql`update commission_tds_rates set threshold_paise = case when pan_status = 'PAN_OK' then 2000000 else 0 end, confirmed_by_ca = false, mode = 'CATCH_UP', effective_to = null`);
  clearRuleCache();
  await tiered();
});

/** An approved TIERED dealer with PAN and a verified bank, who accepted the agent agreement. */
async function newDealer() {
  const user = await createUser({ role: "DEALER" });
  const [dealer] = await db
    .insert(dealers)
    .values({
      userId: user.id,
      legalName: "Shree Sai Network",
      contactName: "Sai",
      dealerType: "PROPRIETORSHIP",
      status: "APPROVED",
      panHash: `pan-${user.id}`,
      bankStatus: "VERIFIED",
      tierAgreementVersion: AGENT_AGREEMENT_VERSION,
      tierAgreementAcceptedAt: new Date(),
    })
    .returning();
  await setDealerCommissionModel(dealer.id, "TIERED", "pilot dealer (test)", admin);
  return { ...dealer, commissionModel: "TIERED" as const };
}

/** A member (lead or agent) who accepted the agreement, with PAN and a verified bank. */
async function member(dealerId: string, name: string, role: "TEAM_LEAD" | "AGENT", parentId: string | null = null, recruitedById: string | null = null, accepted = true): Promise<DealerSalesperson> {
  const view = await addSalesperson(dealerId, { employeeId: name.toUpperCase(), name, role, parentId, recruitedById }, admin);
  const [m] = await db
    .update(dealerSalespeople)
    .set({ panHash: `pan-${view.id}`, panLast4: "123F", bankStatus: "VERIFIED", bankAccountLast4: "4321", ...(accepted ? { agreementVersion: AGENT_AGREEMENT_VERSION, agreementAcceptedAt: new Date() } : {}) })
    .where(eq(dealerSalespeople.id, view.id))
    .returning();
  return m;
}

/** A pending Pune shop on a fee slab (base before GST, + 18%), attributed to the dealer (and member). */
async function signedShop(dealerId: string, signerId: string | null, basePaise = 99_900) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const gst = Math.round(basePaise * 0.18);
  const shop = await createShop(owner.id, { name: `Shop ${Math.random().toString(36).slice(2, 7)}`, status: "PENDING_APPROVAL", shopType: "GENERAL_TRADING" as never, registrationFeePaise: basePaise + gst });
  await db.update(shops).set({ registrationFeeBasePaise: basePaise, registrationFeeDiscountPaise: 0, registrationFeeGstPaise: gst, phone: `9${Math.floor(100_000_000 + Math.random() * 899_999_999)}` }).where(eq(shops.id, shop.id));
  await db.insert(shopAttributions).values({ shopId: shop.id, dealerId, salespersonId: signerId, source: "CODE_AT_REGISTRATION", matchKind: "NONE" });
  await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: basePaise + gst, method: "ONLINE", transactionId: `cf_${shop.id.slice(0, 8)}` }, admin);
  for (const docType of ["PAN", "GSTIN", "SHOP_ACT"] as const) {
    await db.insert(sellerVerifications).values({ shopId: shop.id, docType, status: "VERIFIED", providerId: "mock", verifiedAt: new Date() });
  }
  await approveShop(shop.id, { classification: "KESARI" }, admin);
  return shop;
}

async function deliverOrders(shopId: string, n: number) {
  const buyer = await createUser();
  for (let i = 0; i < n; i++) {
    const order = await createOrder(buyer.id, shopId, { status: "OUT_FOR_DELIVERY" });
    await db.update(orders).set({ deliveryAddressSnapshot: { line1: `${i} Buyer Road`, city: "Pune", pincode: "411001" } }).where(eq(orders.id, order.id));
    await updateOrderStatus(order.id, "DELIVERED", admin);
  }
}

const ledger = async (shopId: string) =>
  (await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.shopId, shopId))).sort((a, b) => a.entryType.localeCompare(b.entryType));
const byType = (rows: Awaited<ReturnType<typeof ledger>>, t: string) => rows.filter((r) => r.entryType === t);

describe("the network: at most three levels", () => {
  it("refuses an agent under an agent (a 4th level) in the service and in the database", async () => {
    const dealer = await newDealer();
    const lead = await member(dealer.id, "Lead", "TEAM_LEAD");
    const agent = await member(dealer.id, "Agent", "AGENT", lead.id);
    await expect(addSalesperson(dealer.id, { employeeId: "X1", name: "Sub", role: "AGENT", parentId: agent.id }, admin)).rejects.toThrow(/4th level|team lead/i);
    await expect(addSalesperson(dealer.id, { employeeId: "X2", name: "Lead2", role: "TEAM_LEAD", parentId: lead.id }, admin)).rejects.toThrow(/3 levels/);
    await expect(
      db.insert(dealerSalespeople).values({ dealerId: dealer.id, employeeId: "X3", name: "Sneaky", teamRole: "AGENT", depth: 4 as never, parentId: agent.id, parentDepth: 3 as never, parentRole: "AGENT" }),
    ).rejects.toThrow();
    await expect(db.update(dealerSalespeople).set({ teamRole: "AGENT" }).where(eq(dealerSalespeople.id, lead.id))).rejects.toThrow();
    const tree = await teamTree(dealer.id);
    expect(tree.members.map((m) => [m.name, m.agents.map((a) => a.name)])).toEqual([["Lead", ["Agent"]]]);
  });

  it("only an admin moves a dealer to TIERED, and only with the rule on", async () => {
    const dealer = await newDealer();
    await expect(setDealerCommissionModel(dealer.id, "STANDARD", "back", { id: admin.id, role: "OPERATOR" })).rejects.toThrow(/admin/i);
    await tiered({ enabled: false });
    await expect(setDealerCommissionModel(dealer.id, "STANDARD", "back to standard", admin)).resolves.toMatchObject({ commissionModel: "STANDARD" });
    await expect(setDealerCommissionModel(dealer.id, "TIERED", "try again", admin)).rejects.toThrow(/rule dealerTieredCommission/);
  });
});

describe("commission per shop on the three fee slabs", () => {
  it.each([
    [99_900, 11_988, 7_992, 4_995, 2_997],
    [499_900, 59_988, 39_992, 24_995, 14_997],
    [999_900, 119_988, 79_992, 49_995, 29_997],
  ])("fee %i: agent under a lead → part 1 at activation, part 2 and both overrides at TRADING (28%%)", async (fee, d1, d2, lead, main) => {
    const dealer = await newDealer();
    const l = await member(dealer.id, "Lead", "TEAM_LEAD");
    const a = await member(dealer.id, "Agent", "AGENT", l.id);
    const shop = await signedShop(dealer.id, a.id, fee);

    const atActivation = await ledger(shop.id);
    expect(atActivation).toHaveLength(1);
    expect(atActivation[0]).toMatchObject({ entryType: "DIRECT_1", milestone: "ACTIVATED", amountPaise: d1, payeeMemberId: a.id, level: 3, status: "EARNED", feePaise: fee });

    await deliverOrders(shop.id, 2);
    const rows = await ledger(shop.id);
    expect(byType(rows, "DIRECT_2")[0]).toMatchObject({ amountPaise: d2, payeeMemberId: a.id, milestone: "TRADING" });
    expect(byType(rows, "OVERRIDE_LEAD")[0]).toMatchObject({ amountPaise: lead, payeeMemberId: l.id, level: 2 });
    expect(byType(rows, "OVERRIDE_MAIN")[0]).toMatchObject({ amountPaise: main, payeeMemberId: null, level: 1 });
    expect(rows.reduce((s, r) => s + r.amountPaise, 0)).toBe(Math.round((fee * 2800) / 10_000));
    const [plan] = await db.select().from(dealerTierShopPlans).where(eq(dealerTierShopPlans.shopId, shop.id));
    expect(plan).toMatchObject({ status: "TRADING", deliveredOrders: 2 });
    // A later delivery adds nothing (idempotent).
    await deliverOrders(shop.id, 1);
    expect(await ledger(shop.id)).toHaveLength(4);
  });

  it("missing levels are not paid: an agent under the main dealer gets no lead override; the main dealer's own shop has no override", async () => {
    const dealer = await newDealer();
    const a = await member(dealer.id, "Solo", "AGENT");
    const viaAgent = await signedShop(dealer.id, a.id, 499_900);
    const own = await signedShop(dealer.id, null, 499_900);
    await deliverOrders(viaAgent.id, 2);
    await deliverOrders(own.id, 2);
    const agentRows = await ledger(viaAgent.id);
    expect(agentRows.map((r) => r.entryType).sort()).toEqual(["DIRECT_1", "DIRECT_2", "OVERRIDE_MAIN"]);
    const ownRows = await ledger(own.id);
    expect(ownRows.map((r) => [r.entryType, r.payeeMemberId, r.level])).toEqual([
      ["DIRECT_1", null, 1],
      ["DIRECT_2", null, 1],
    ]);
    expect(ownRows.reduce((s, r) => s + r.amountPaise, 0)).toBe(99_980);
  });

  it("a team lead's own shop: direct to him and the main override, no lead override to himself", async () => {
    const dealer = await newDealer();
    const l = await member(dealer.id, "Lead", "TEAM_LEAD");
    const shop = await signedShop(dealer.id, l.id, 99_900);
    await deliverOrders(shop.id, 2);
    expect((await ledger(shop.id)).map((r) => r.entryType).sort()).toEqual(["DIRECT_1", "DIRECT_2", "OVERRIDE_MAIN"]);
  });

  it("no per-shop cap (owner, 5 Nov 2026): every level is earned in full, nothing waits for an admin", async () => {
    const dealer = await newDealer();
    const l = await member(dealer.id, "Lead", "TEAM_LEAD");
    const a = await member(dealer.id, "Agent", "AGENT", l.id);
    const shop = await signedShop(dealer.id, a.id, 999_900);
    await deliverOrders(shop.id, 2);
    const rows = await ledger(shop.id);
    expect(rows.every((r) => !r.aboveCap && r.status === "EARNED")).toBe(true);
    expect(rows.reduce((s, r) => s + r.amountPaise, 0)).toBe(279_972);
  });
});

describe("gap report A8 / A9: history, registration-date mapping, mapping table", () => {
  it("commission follows the team on the shop's REGISTRATION date: a move before activation pays the old lead", async () => {
    const dealer = await newDealer();
    const oldLead = await member(dealer.id, "Old Lead", "TEAM_LEAD");
    const newLead = await member(dealer.id, "New Lead", "TEAM_LEAD");
    const agent = await member(dealer.id, "Agent", "AGENT", oldLead.id);
    // The shop registers under the old lead…
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { name: "Moved Mart", status: "PENDING_APPROVAL", shopType: "GENERAL_TRADING" as never, registrationFeePaise: 117_882 });
    await db.update(shops).set({ registrationFeeBasePaise: 99_900, registrationFeeDiscountPaise: 0, registrationFeeGstPaise: 17_982 }).where(eq(shops.id, shop.id));
    await db.insert(shopAttributions).values({ shopId: shop.id, dealerId: dealer.id, salespersonId: agent.id, source: "CODE_AT_REGISTRATION", matchKind: "NONE" });
    // …then the agent moves to the new lead before the shop is approved.
    await setMemberPlacement(agent.id, { role: "AGENT", parentId: newLead.id }, "territory change (test)", admin);
    await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 117_882, method: "ONLINE", transactionId: `cf_${shop.id.slice(0, 8)}` }, admin);
    for (const docType of ["PAN", "GSTIN", "SHOP_ACT"] as const) {
      await db.insert(sellerVerifications).values({ shopId: shop.id, docType, status: "VERIFIED", providerId: "mock", verifiedAt: new Date() });
    }
    await approveShop(shop.id, { classification: "KESARI" }, admin);
    const [plan] = await db.select().from(dealerTierShopPlans).where(eq(dealerTierShopPlans.shopId, shop.id));
    expect(plan.leadMemberId).toBe(oldLead.id);
    // A shop registered after the move follows the new lead.
    const later = await signedShop(dealer.id, agent.id, 99_900);
    const [laterPlan] = await db.select().from(dealerTierShopPlans).where(eq(dealerTierShopPlans.shopId, later.id));
    expect(laterPlan.leadMemberId).toBe(newLead.id);

    const history = await mappingHistory(dealer.id, agent.id);
    expect(history.map((h) => [h.leadName, h.validTo === null, h.reason])).toEqual([
      ["New Lead", true, "territory change (test)"],
      ["Old Lead", false, "added to the team"],
    ]);
  });

  it("every agreement acceptance is kept with version, text hash, time and device", async () => {
    const dealer = await newDealer();
    const user = await createUser({ role: "DEALER" });
    const a = await member(dealer.id, "Agent", "AGENT", null, null, false);
    await db.update(dealerSalespeople).set({ userId: user.id }).where(eq(dealerSalespeople.id, a.id));
    await acceptAgentAgreement({ id: user.id, role: "DEALER" }, AGENT_AGREEMENT_VERSION, { ipAddress: "10.0.0.1", userAgent: "QA" });
    await acceptAgentAgreement({ id: user.id, role: "DEALER" }, AGENT_AGREEMENT_VERSION, { ipAddress: "10.0.0.2", userAgent: "QA2" });
    const rows = await db.select().from(dealerAgreementAcceptances).where(eq(dealerAgreementAcceptances.memberId, a.id));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.ipAddress).sort()).toEqual(["10.0.0.1", "10.0.0.2"]);
    expect(rows[0]).toMatchObject({ version: AGENT_AGREEMENT_VERSION, textSha256: AGENT_AGREEMENT_SHA256, userId: user.id });
  });

  it("the team mapping table counts each person's shops and commission, and exports CSV with masked mobiles", async () => {
    const dealer = await newDealer();
    const l = await member(dealer.id, "Lead", "TEAM_LEAD");
    await db.update(dealerSalespeople).set({ mobileE164: "+919876543210" }).where(eq(dealerSalespeople.id, l.id));
    const a = await member(dealer.id, "Agent", "AGENT", l.id);
    const shop = await signedShop(dealer.id, a.id, 99_900);
    await deliverOrders(shop.id, 2);
    const rows = await teamMapping(dealer.id);
    const agentRow = rows.find((r) => r.memberId === a.id)!;
    expect(agentRow).toMatchObject({ role: "AGENT", level: 3, leadName: "Lead", registered: 1, activated: 1, trading: 1, active30: 1, commissionAllPaise: 19_980 });
    expect(rows.find((r) => r.memberId === l.id)).toMatchObject({ commissionAllPaise: 4_995, mobileMasked: "+91••••••3210" });
    expect(rows.find((r) => r.memberId === null)).toMatchObject({ role: "MAIN_DEALER", commissionAllPaise: 2_997 });
    expect((await teamMapping(dealer.id, { role: "AGENT" })).map((r) => r.memberId)).toEqual([a.id]);
    const csv = teamMappingCsv(rows);
    expect(csv).toContain("+91••••••3210");
    expect(csv).not.toContain("9876543210");
    expect((await memberShops(dealer.id, a.id))[0]).toMatchObject({ shopId: shop.id, signedBy: "Agent", plan: "TRADING" });
  });
});

describe("DP-1: moving a dealer to TIERED never pays a shop twice", () => {
  it("a shop that earned on the standard model stays on it: no TIERED plan, no DIRECT_1", async () => {
    const user = await createUser({ role: "DEALER" });
    const [standard] = await db
      .insert(dealers)
      .values({ userId: user.id, legalName: "Old Network", contactName: "O", dealerType: "PROPRIETORSHIP", status: "APPROVED", panHash: `pan-${user.id}`, bankStatus: "VERIFIED", tierAgreementVersion: AGENT_AGREEMENT_VERSION, tierAgreementAcceptedAt: new Date() })
      .returning();
    const shop = await signedShop(standard.id, null);
    const before = await ledger(shop.id);
    expect(byType(before, "BASE").length).toBeGreaterThan(0);
    await setDealerCommissionModel(standard.id, "TIERED", "moved after the shop earned (test)", admin);
    await checkCommissionMilestones(shop.id, admin);
    const after = await ledger(shop.id);
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    expect(await db.select().from(dealerTierShopPlans).where(eq(dealerTierShopPlans.shopId, shop.id))).toHaveLength(0);
    // A shop signed after the move earns on TIERED as usual.
    const fresh = await signedShop(standard.id, null);
    expect(byType(await ledger(fresh.id), "DIRECT_1")).toHaveLength(1);
  });
});

describe("only a fee actually paid earns", () => {
  it("an approved shop whose fee is still due earns nothing until the fee is paid", async () => {
    const dealer = await newDealer();
    const a = await member(dealer.id, "Agent", "AGENT");
    const shop = await signedShop(dealer.id, a.id, 99_900);
    await db.delete(dealerCommissionLedger).where(eq(dealerCommissionLedger.shopId, shop.id));
    await db.delete(dealerTierShopPlans).where(eq(dealerTierShopPlans.shopId, shop.id));
    await db.update(shops).set({ feePaymentStatus: "PENDING" }).where(eq(shops.id, shop.id));
    await checkCommissionMilestones(shop.id);
    expect(await ledger(shop.id)).toHaveLength(0);
    await db.update(shops).set({ feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));
    await checkCommissionMilestones(shop.id);
    expect((await ledger(shop.id)).map((r) => [r.entryType, r.amountPaise])).toEqual([["DIRECT_1", 11_988]]);
  });
});

describe("TRADING lapse", () => {
  it("not reached within the days: part 2 and the overrides lapse with a ledger note; later orders pay nothing", async () => {
    const dealer = await newDealer();
    const l = await member(dealer.id, "Lead", "TEAM_LEAD");
    const a = await member(dealer.id, "Agent", "AGENT", l.id);
    const shop = await signedShop(dealer.id, a.id, 99_900);
    await deliverOrders(shop.id, 1);
    await db.update(dealerTierShopPlans).set({ tradingDeadline: new Date() }).where(eq(dealerTierShopPlans.shopId, shop.id));
    expect(await runTieredDaily(new Date(Date.now() + 5_000))).toMatchObject({ checked: 1, lapsed: 1 });
    const rows = await ledger(shop.id);
    const lapsed = rows.filter((r) => r.entryType !== "DIRECT_1");
    expect(lapsed.map((r) => r.entryType).sort()).toEqual(["DIRECT_2", "OVERRIDE_LEAD", "OVERRIDE_MAIN"]);
    expect(lapsed.every((r) => r.amountPaise === 0 && r.status === "REVERSED" && /lapsed: 1 of 2 orders delivered/.test(r.note ?? ""))).toBe(true);
    expect(byType(rows, "DIRECT_1")[0].amountPaise).toBe(11_988);
    await deliverOrders(shop.id, 3);
    expect((await ledger(shop.id)).reduce((s, r) => s + r.amountPaise, 0)).toBe(11_988);
    expect((await tradingProgress(dealer.id))[0]).toMatchObject({ status: "LAPSED" });
  });
});

describe("promotion and the development bonus", () => {
  it("needs the activated shops unless an admin overrides; he moves with his recruits; the former lead earns 1% on that team", async () => {
    await tiered({ promotionMinShops: 3 });
    const dealer = await newDealer();
    const oldLead = await member(dealer.id, "Old Lead", "TEAM_LEAD");
    const star = await member(dealer.id, "Star", "AGENT", oldLead.id);
    const recruit = await member(dealer.id, "Recruit", "AGENT", oldLead.id, star.id);
    await signedShop(dealer.id, star.id, 99_900);

    await expect(promoteToTeamLead(star.id, { reason: "great work" }, admin)).rejects.toThrow(/Not eligible yet: 1 of 3/);
    const result = await promoteToTeamLead(star.id, { reason: "great work, owner approved", override: true }, admin);
    expect(result.movedAgents).toBe(1);
    const [now] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, star.id));
    expect(now).toMatchObject({ teamRole: "TEAM_LEAD", depth: 2, parentId: null });
    const [moved] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, recruit.id));
    expect(moved).toMatchObject({ depth: 3, parentId: star.id });
    const [dev] = await db.select().from(dealerTeamDevelopments).where(eq(dealerTeamDevelopments.teamLeadMemberId, star.id));
    expect(dev).toMatchObject({ beneficiaryMemberId: oldLead.id, bp: 100 });
    expect(Math.round((dev.endsAt.getTime() - dev.startsAt.getTime()) / 86_400_000)).toBeGreaterThanOrEqual(181);

    // The recruit signs a ₹9,999 shop: lead override to the new lead; 1% development to the old one when the month closes.
    const shop = await signedShop(dealer.id, recruit.id, 999_900);
    await deliverOrders(shop.id, 2);
    expect(byType(await ledger(shop.id), "OVERRIDE_LEAD")[0]).toMatchObject({ payeeMemberId: star.id, amountPaise: 49_995 });
    expect(byType(await ledger(shop.id), "DEVELOPMENT")).toHaveLength(0);
    await closeThisMonth();
    expect(byType(await ledger(shop.id), "DEVELOPMENT")[0]).toMatchObject({ payeeMemberId: oldLead.id, amountPaise: 9_999, milestone: "MONTHLY" });
  });

  it("the development bonus stops after its months", async () => {
    const dealer = await newDealer();
    const oldLead = await member(dealer.id, "Old Lead", "TEAM_LEAD");
    const star = await member(dealer.id, "Star", "AGENT", oldLead.id);
    await promoteToTeamLead(star.id, { reason: "promotion (test)", override: true }, admin);
    await db.update(dealerTeamDevelopments).set({ startsAt: new Date(Date.now() - 200 * 86_400_000), endsAt: new Date(Date.now() - 10 * 86_400_000) });
    const agent = await member(dealer.id, "New", "AGENT", star.id);
    const shop = await signedShop(dealer.id, agent.id, 99_900);
    await deliverOrders(shop.id, 2);
    await closeThisMonth();
    expect(byType(await ledger(shop.id), "DEVELOPMENT")).toHaveLength(0);
  });
});

describe("the owner's structure (5 Nov 2026): 20% / 4% / 2%, all earned at registration, no cap", () => {
  it("an agent's shop: 20% to the agent, 4% to his lead, 2% to the main dealer — all at once, nothing waits for orders", async () => {
    await ownerStructure();
    const dealer = await newDealer();
    const l = await member(dealer.id, "Ramesh", "TEAM_LEAD");
    const a = await member(dealer.id, "Agent", "AGENT", l.id);
    const shop = await signedShop(dealer.id, a.id, 499_900);
    const rows = await ledger(shop.id);
    expect(rows.map((r) => [r.entryType, r.payeeMemberId, r.amountPaise, r.status])).toEqual([
      ["DIRECT_1", a.id, 99_980, "EARNED"],
      ["OVERRIDE_LEAD", l.id, 19_996, "EARNED"],
      ["OVERRIDE_MAIN", null, 9_998, "EARNED"],
    ]);
    const [plan] = await db.select().from(dealerTierShopPlans).where(eq(dealerTierShopPlans.shopId, shop.id));
    expect(plan).toMatchObject({ status: "TRADING", tradingOrders: 0, firstPartBp: 10_000 });
  });

  it("a team lead's own shop: 20% to him and 2% to the main dealer (no 4% to himself); the main dealer's own shop: 20% only", async () => {
    await ownerStructure();
    const dealer = await newDealer();
    const l = await member(dealer.id, "Ramesh", "TEAM_LEAD");
    const leadShop = await signedShop(dealer.id, l.id, 499_900);
    expect((await ledger(leadShop.id)).map((r) => [r.entryType, r.payeeMemberId, r.amountPaise])).toEqual([
      ["DIRECT_1", l.id, 99_980],
      ["OVERRIDE_MAIN", null, 9_998],
    ]);
    const ownShop = await signedShop(dealer.id, null, 499_900);
    expect((await ledger(ownShop.id)).map((r) => [r.entryType, r.payeeMemberId, r.amountPaise])).toEqual([["DIRECT_1", null, 99_980]]);
  });

  it("the former lead's 1% is paid only for a month the new team reaches the minimum (his own shops count)", async () => {
    await ownerStructure({ developmentMinShopsPerMonth: 2 });
    // Ramesh's team: Suresh is promoted, then Suresh and his agent sign 2 shops this month → minimum reached.
    const dealer = await newDealer();
    const ramesh = await member(dealer.id, "Ramesh", "TEAM_LEAD");
    const suresh = await member(dealer.id, "Suresh", "AGENT", ramesh.id);
    await promoteToTeamLead(suresh.id, { reason: "promotion (test)", override: true }, admin);
    const agent = await member(dealer.id, "Suresh agent", "AGENT", suresh.id);
    const own = await signedShop(dealer.id, suresh.id, 499_900);
    const viaAgent = await signedShop(dealer.id, agent.id, 499_900);
    // Another network: the promoted lead's team signs only 1 shop → nothing for the month.
    const other = await newDealer();
    const oldLead = await member(other.id, "Old lead", "TEAM_LEAD");
    const newLead = await member(other.id, "New lead", "AGENT", oldLead.id);
    await promoteToTeamLead(newLead.id, { reason: "promotion (test)", override: true }, admin);
    const lone = await signedShop(other.id, newLead.id, 499_900);
    expect(byType(await ledger(own.id), "DEVELOPMENT")).toHaveLength(0);

    await closeThisMonth();
    for (const shop of [own, viaAgent]) {
      expect(byType(await ledger(shop.id), "DEVELOPMENT")[0]).toMatchObject({ payeeMemberId: ramesh.id, amountPaise: 4_999, status: "APPROVED", milestone: "MONTHLY" });
    }
    expect(byType(await ledger(viaAgent.id), "OVERRIDE_LEAD")[0]).toMatchObject({ payeeMemberId: suresh.id, amountPaise: 19_996 });
    const [missed] = byType(await ledger(lone.id), "DEVELOPMENT");
    expect(missed).toMatchObject({ payeeMemberId: oldLead.id, amountPaise: 0, status: "REVERSED" });
    expect(missed.note).toMatch(/activated 1 shop — monthly minimum 2 not reached/);
    // Two paid, one recorded as not reached.
    expect((await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.entryType, "DEVELOPMENT"))).length).toBe(3);
  });
});

describe("renewal commission", () => {
  it("10% of a paid renewal (before GST) to the direct earner while the shop is active; off → nothing", async () => {
    const dealer = await newDealer();
    const a = await member(dealer.id, "Agent", "AGENT");
    const shop = await signedShop(dealer.id, a.id, 99_900);
    await recordPayment({ shopId: shop.id, paymentType: "RENEWAL", amountPaise: 117_882, method: "ONLINE", transactionId: `rn_${shop.id.slice(0, 8)}` }, admin);
    const [renewal] = byType(await ledger(shop.id), "RENEWAL");
    expect(renewal).toMatchObject({ amountPaise: 9_990, payeeMemberId: a.id, milestone: "RENEWAL", feePaise: 99_900 });

    await tiered({ renewalEnabled: false });
    await recordPayment({ shopId: shop.id, paymentType: "RENEWAL", amountPaise: 117_882, method: "ONLINE", transactionId: `rn2_${shop.id.slice(0, 8)}` }, admin);
    expect(byType(await ledger(shop.id), "RENEWAL")).toHaveLength(1);
  });
});

describe("reversal takes back every level", () => {
  it("a refund reverses direct, overrides and development; a paid entry gets a negative entry for its own payee", async () => {
    const dealer = await newDealer();
    const l = await member(dealer.id, "Lead", "TEAM_LEAD");
    const a = await member(dealer.id, "Agent", "AGENT", l.id);
    const shop = await signedShop(dealer.id, a.id, 499_900);
    await deliverOrders(shop.id, 2);
    // Part 1 is paid to the agent.
    const [d1] = byType(await ledger(shop.id), "DIRECT_1");
    await approveEntries([d1.id], admin);
    const batch = await createPayoutBatch(dealer.id, admin, "agent payout", a.id);
    expect(batch).toMatchObject({ memberId: a.id, totalPaise: 59_988, tdsPaise: 0 });
    await markPayoutPaid(batch.id, "UTR-AGENT-1", admin);

    await recordPayment({ shopId: shop.id, paymentType: "REFUND", amountPaise: 589_882, method: "ONLINE" }, admin);
    const rows = await ledger(shop.id);
    const accruals = rows.filter((r) => r.kind === "ACCRUAL");
    expect(accruals.filter((r) => r.id !== d1.id).every((r) => r.status === "REVERSED")).toBe(true);
    const negative = rows.find((r) => r.kind === "REVERSAL");
    expect(negative).toMatchObject({ amountPaise: -59_988, payeeMemberId: a.id, entryType: "DIRECT_1", status: "EARNED" });
    const [plan] = await db.select().from(dealerTierShopPlans).where(eq(dealerTierShopPlans.shopId, shop.id));
    expect(plan.status).toBe("REVERSED");
    // The agent's next payout carries the negative balance: nothing to pay.
    await expect(createPayoutBatch(dealer.id, admin, null, a.id)).rejects.toThrow(/owes/);
  });
});

describe("agent agreement, payee checks and TDS", () => {
  it("commission waits ON_HOLD until the member accepts the agent agreement, then is released", async () => {
    const dealer = await newDealer();
    const user = await createUser({ role: "DEALER" });
    const a = await member(dealer.id, "New Agent", "AGENT", null, null, false);
    await db.update(dealerSalespeople).set({ userId: user.id }).where(eq(dealerSalespeople.id, a.id));
    const shop = await signedShop(dealer.id, a.id, 99_900);
    const [held] = await ledger(shop.id);
    expect(held).toMatchObject({ status: "ON_HOLD", heldFromStatus: "EARNED" });
    expect(held.note).toMatch(/agent agreement/);
    await expect(acceptAgentAgreement({ id: user.id, role: "DEALER" }, "1999-01-01")).rejects.toThrow(/changed/);
    expect(await acceptAgentAgreement({ id: user.id, role: "DEALER" }, AGENT_AGREEMENT_VERSION)).toEqual({ released: 1 });
    expect((await ledger(shop.id))[0]).toMatchObject({ status: "EARNED", note: null });
  });

  it("a payout is paid only with the payee's PAN and a verified bank account", async () => {
    const dealer = await newDealer();
    const a = await member(dealer.id, "Agent", "AGENT");
    await db.update(dealerSalespeople).set({ bankStatus: "PENDING" }).where(eq(dealerSalespeople.id, a.id));
    const shop = await signedShop(dealer.id, a.id, 99_900);
    const [d1] = await ledger(shop.id);
    await approveEntries([d1.id], admin);
    const batch = await createPayoutBatch(dealer.id, admin, null, a.id);
    await expect(markPayoutPaid(batch.id, "UTR-1", admin)).rejects.toThrow(/bank account is not verified/);
    await db.update(dealerSalespeople).set({ bankStatus: "VERIFIED" }).where(eq(dealerSalespeople.id, a.id));
    await expect(markPayoutPaid(batch.id, "UTR-1", admin)).resolves.toMatchObject({ status: "PAID" });
  });

  it("TDS off: gross = net; TDS on: 2% once the year passes ₹20,000 (with catch-up), shown as gross, TDS, net", async () => {
    const dealer = await newDealer();
    const first = await signedShop(dealer.id, null, 999_900);
    await approveEntries((await ledger(first.id)).map((r) => r.id), admin);
    const off = await createPayoutBatch(dealer.id, admin);
    expect(off).toMatchObject({ totalPaise: 119_988, tdsPaise: 0 });
    await markPayoutPaid(off.id, "UTR-OFF", admin);

    await setRule("dealerPayoutTds", { enabled: true, rateBp: 200, annualThresholdPaise: 200_000 }, admin);
    clearRuleCache();
    // Gap report D1: the dated row decides (here a CA-confirmed 2% above ₹2,000 for the test).
    await db.update(commissionTdsRates).set({ thresholdPaise: 200_000, confirmedByCa: true }).where(and(eq(commissionTdsRates.payeeType, "ANY"), eq(commissionTdsRates.panStatus, "PAN_OK")));
    const second = await signedShop(dealer.id, null, 999_900);
    await approveEntries((await ledger(second.id)).map((r) => r.id), admin);
    const on = await createPayoutBatch(dealer.id, admin);
    // ₹1,199.88 earlier + ₹1,199.88 now = ₹2,399.76 > ₹2,000 → 2% of the year = ₹48.00 (catch-up).
    expect(on).toMatchObject({ totalPaise: 119_988, tdsPaise: 4_800, tdsRateBp: 200 });
  });
});

describe("monthly close per payee, with target bonuses", () => {
  it("drafts one payout per payee and pays the highest target reached", async () => {
    await tiered({ targetBonusesEnabled: true, targets: [{ role: "AGENT", minShops: 2, bonusPaise: 100_000 }, { role: "MAIN_DEALER", minShops: 3, bonusPaise: 50_000 }] });
    const dealer = await newDealer();
    const a = await member(dealer.id, "Agent", "AGENT");
    await signedShop(dealer.id, a.id, 99_900);
    await signedShop(dealer.id, a.id, 99_900);
    await signedShop(dealer.id, null, 99_900);
    const month = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
    const after = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 2));
    const result = await closeCommissionMonth(month, admin, after);
    const bonuses = await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.entryType, "BONUS"));
    expect(bonuses.map((b) => [b.payeeMemberId, b.amountPaise]).sort()).toEqual([
      [a.id, 100_000],
      [null, 50_000],
    ].sort());
    expect(result.payouts.map((p) => [p.memberId, p.totalPaise]).sort()).toEqual([
      [a.id, 11_988 * 2 + 100_000],
      [null, 11_988 + 50_000],
    ].sort());
    const batches = await db.select().from(dealerPayoutBatches).where(and(eq(dealerPayoutBatches.dealerId, dealer.id), eq(dealerPayoutBatches.periodMonth, month)));
    expect(batches).toHaveLength(2);
    const earnings = await earningsByType(dealer.id, a.id);
    expect(earnings.map((e) => e.entryType).sort()).toEqual(["BONUS", "DIRECT_1"]);
  });
});

describe("standard dealers are unchanged", () => {
  it("a STANDARD dealer still earns the base 40% in one entry while the TIERED rule is on", async () => {
    const user = await createUser({ role: "DEALER" });
    const [dealer] = await db.insert(dealers).values({ userId: user.id, legalName: "Old Dealer", contactName: "Old", dealerType: "INDIVIDUAL", status: "APPROVED" }).returning();
    const shop = await signedShop(dealer.id, null, 99_900);
    const rows = await ledger(shop.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entryType: "BASE", milestone: "ACTIVATED", amountPaise: 39_960, payeeMemberId: null, accrualKey: null });
    await deliverOrders(shop.id, 2);
    expect(await ledger(shop.id)).toHaveLength(1);
    expect(await checkTradingMilestone(shop.id)).toBe("NONE");
  });
});
