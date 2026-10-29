/**
 * Dealer commission paid monthly (owner, 28 Oct 2026; docs/dealer-programme):
 * on the payout day (default the 5th) the month before is closed once — a draft
 * payout per dealer from approved commission up to the month's end, netted
 * with reversals — and every dealer gets that month's statement.
 *
 *   - before the payout day nothing happens; on it the month closes, once
 *   - auto-approval at the close is on by default (owner, 29 Oct 2026); switched
 *     off, only approved entries are paid;
 *     above-cap and held entries never; this month's entries wait for next month
 *   - reversals owed back are carried forward, not paid as a negative payout
 *   - a cancelled draft's entries go into the next month's payout
 *   - the statement: shops registered, activated, earned, the payout; CSV for
 *     the dealer's own month only; a notice to each dealer
 *   - admin "close now" (operator refused, a month not over refused), paying a
 *     monthly draft tells the dealer as before; payout day validated; programme off
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { POST as commissionPost } from "@/app/api/admin/dealer-commission/route";
import { GET as statementGet } from "@/app/api/dealer/commission/statement/route";
import { db } from "@/server/db";
import {
  auditLogs,
  dealerCommissionLedger,
  dealerCommissionMonths,
  dealerCommissionRules,
  dealerCommissionSettings,
  dealerPayoutBatches,
  dealers,
  notifications,
  shopAttributions,
  shops,
} from "@/server/db/schema";
import { approveEntries, cancelPayout, getCommissionSettings, markPayoutPaid, reverseEntry, setCommissionSettings } from "@/server/dealers/commission";
import {
  closeCommissionMonth,
  dealerMonthStatement,
  monthBounds,
  monthLabel,
  monthStatementCsv,
  previousMonth,
  runMonthlyDealerPayout,
} from "@/server/dealers/monthly-payout";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { recordPayment } from "@/server/services/shop-payments";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

let admin: { id: string; email: string; name: string | null; role: "ADMIN" };

/** 5 Oct 2026, 06:00 IST — the daily job's first run on the payout day. */
const PAYOUT_DAY = new Date("2026-10-05T06:00:00+05:30");
const SEPT = "2026-09";
const IN_SEPT = new Date("2026-09-15T12:00:00+05:30");

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

beforeEach(async () => {
  await resetDatabase();
  await db.delete(dealerCommissionLedger);
  await db.delete(dealerPayoutBatches);
  await db.delete(dealerCommissionMonths);
  await db.delete(dealerCommissionRules);
  await db.insert(dealerCommissionRules).values(
    (["REGISTERED", "VERIFIED_CATALOGUE", "ACTIVATED"] as const).map((milestone, i) => ({
      ruleKey: crypto.randomUUID(),
      version: 1,
      shopScope: "STANDARD" as const,
      milestone,
      fixedPaise: [10_000, 15_000, 15_000][i],
      effectiveFrom: "2026-01-01",
      changeReason: "pilot default (test)",
    })),
  );
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, email: a.email, name: a.name, role: "ADMIN" };
  // Payout tests: the fixed ₹ amounts of the milestone rules model (the base % model is in dealer-base-commission.test.ts).
  await setCommissionSettings(
    { capPaise: 99_900, fixedBonusBase: "FEE", catalogueMinProducts: 1, branchEligible: false, payoutDayOfMonth: 5, autoApproveAtMonthEnd: false, commissionModel: "MILESTONE_RULES" },
    "test defaults",
    admin,
  );
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", admin);
  await setFeatureFlag("dealer_rating_bonus_enabled", { enabled: false, districtCodes: null }, "no bonus (test)", admin);
});

async function newDealer(name = "Shree Sai") {
  const user = await createUser({ role: "DEALER" });
  const [dealer] = await db.insert(dealers).values({ userId: user.id, legalName: name, contactName: name, dealerType: "PROPRIETORSHIP", status: "APPROVED" }).returning();
  return { user, dealer };
}

/** A Pune shop the dealer registered, its fee paid (the REGISTERED milestone, ₹100), all dated `at`. */
async function registeredShop(dealerId: string, at: Date, name = "Ganesh Traders") {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name, status: "PENDING_APPROVAL", shopType: "GENERAL_TRADING" as never, registrationFeePaise: 118_000 });
  await db.update(shops).set({ registrationFeeBasePaise: 100_000, registrationFeeDiscountPaise: 0, registrationFeeGstPaise: 18_000 }).where(eq(shops.id, shop.id));
  await db.insert(shopAttributions).values({ shopId: shop.id, dealerId, source: "CODE_AT_REGISTRATION" });
  await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 118_000, method: "ONLINE", transactionId: `cf_${shop.id.slice(0, 8)}` }, admin);
  await db.update(shopAttributions).set({ createdAt: at }).where(eq(shopAttributions.shopId, shop.id));
  await db.update(dealerCommissionLedger).set({ createdAt: at }).where(eq(dealerCommissionLedger.shopId, shop.id));
  const entries = await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.shopId, shop.id));
  expect(entries).toHaveLength(1);
  return { shop, entry: entries[0] };
}

const batchesOf = (dealerId: string) => db.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.dealerId, dealerId));
const notices = (userId: string, type: string) => db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type)));

describe("months", () => {
  it("previous month, IST bounds and labels", () => {
    expect(previousMonth("2026-10-05")).toBe("2026-09");
    expect(previousMonth("2026-01-05")).toBe("2025-12");
    expect(monthLabel("2026-09")).toBe("September 2026");
    const { start, end } = monthBounds("2026-12");
    expect(start.toISOString()).toBe("2026-11-30T18:30:00.000Z");
    expect(end.toISOString()).toBe("2026-12-31T18:30:00.000Z");
  });
});

describe("the daily job closes the month on the payout day, once", () => {
  it("nothing before the 5th; on the 5th a draft payout of September's approved commission and the statement; a second run changes nothing", async () => {
    const { user, dealer } = await newDealer();
    const a = await registeredShop(dealer.id, IN_SEPT, "Ganesh Traders");
    const b = await registeredShop(dealer.id, IN_SEPT, "Sai Kirana");
    await approveEntries([a.entry.id], admin); // b stays EARNED: not approved, not paid

    expect(await runMonthlyDealerPayout(new Date("2026-10-04T06:00:00+05:30"))).toEqual({ skipped: "before day 5" });
    expect(await batchesOf(dealer.id)).toHaveLength(0);

    const result = await runMonthlyDealerPayout(PAYOUT_DAY);
    expect(result).toMatchObject({ month: SEPT, alreadyClosed: false, payouts: [{ dealerId: dealer.id, totalPaise: 10_000, entries: 1 }] });
    const [batch] = await batchesOf(dealer.id);
    expect(batch).toMatchObject({ status: "DRAFT", periodMonth: SEPT, totalPaise: 10_000, createdBy: null });
    const [stillEarned] = await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.id, b.entry.id));
    expect(stillEarned).toMatchObject({ status: "EARNED", payoutBatchId: null });

    // The dealer's statement notice: shops registered, earned, the payout.
    const [notice] = await notices(user.id, "dealer.commission_statement");
    expect(notice.title).toBe("Your commission statement for September 2026");
    expect(notice.body).toContain("2 shops registered");
    expect(notice.body).toContain("₹200");
    expect(notice.body).toContain("₹100");
    expect(notice.actionUrl).toBe("/dealer?statement=2026-09");

    expect(await runMonthlyDealerPayout(new Date("2026-10-06T06:00:00+05:30"))).toEqual({ skipped: "2026-09 already closed" });
    expect(await closeCommissionMonth(SEPT, admin, PAYOUT_DAY)).toMatchObject({ alreadyClosed: true });
    expect(await batchesOf(dealer.id)).toHaveLength(1);
    expect(await notices(user.id, "dealer.commission_statement")).toHaveLength(1);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "dealer.commission_month_closed"));
    expect(audit.newValue).toMatchObject({ month: SEPT, payouts: 1, totalPaise: 10_000 });
  });

  it("a missed run catches up later in the month", async () => {
    const { dealer } = await newDealer();
    const a = await registeredShop(dealer.id, IN_SEPT);
    await approveEntries([a.entry.id], admin);
    const result = await runMonthlyDealerPayout(new Date("2026-10-09T06:00:00+05:30"));
    expect(result).toMatchObject({ month: SEPT, payouts: [{ totalPaise: 10_000 }] });
  });

  it("approval at the close is on by default (owner, 29 Oct 2026): a fresh settings row and the fallback both say so", async () => {
    await db.delete(dealerCommissionSettings);
    expect((await getCommissionSettings()).autoApproveAtMonthEnd).toBe(true);
    const [row] = await db.insert(dealerCommissionSettings).values({}).returning();
    expect(row.autoApproveAtMonthEnd).toBe(true);
  });

  it("with auto-approval at the close, September's earned commission is approved and paid; above-cap and held entries are not; October's waits", async () => {
    await setCommissionSettings({ autoApproveAtMonthEnd: true }, "owner: pay what is earned", admin);
    const { dealer } = await newDealer();
    const a = await registeredShop(dealer.id, IN_SEPT, "One");
    const held = await registeredShop(dealer.id, IN_SEPT, "Two");
    const above = await registeredShop(dealer.id, IN_SEPT, "Three");
    const october = await registeredShop(dealer.id, new Date("2026-10-02T10:00:00+05:30"), "Four");
    await db.update(dealerCommissionLedger).set({ status: "ON_HOLD", heldFromStatus: "EARNED" }).where(eq(dealerCommissionLedger.id, held.entry.id));
    await db.update(dealerCommissionLedger).set({ status: "PENDING", aboveCap: true }).where(eq(dealerCommissionLedger.id, above.entry.id));

    const result = await runMonthlyDealerPayout(PAYOUT_DAY);
    expect(result).toMatchObject({ autoApproved: 1, payouts: [{ totalPaise: 10_000, entries: 1 }] });
    const status = async (id: string) => (await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.id, id)))[0];
    expect(await status(a.entry.id)).toMatchObject({ status: "APPROVED", payoutBatchId: expect.any(String) });
    expect(await status(held.entry.id)).toMatchObject({ status: "ON_HOLD", payoutBatchId: null });
    expect(await status(above.entry.id)).toMatchObject({ status: "PENDING", payoutBatchId: null });
    expect(await status(october.entry.id)).toMatchObject({ status: "EARNED", payoutBatchId: null });
  });

  it("approved commission left over from an earlier month is paid with this one", async () => {
    const { dealer } = await newDealer();
    const old = await registeredShop(dealer.id, new Date("2026-07-20T10:00:00+05:30"), "July shop");
    const sept = await registeredShop(dealer.id, IN_SEPT, "September shop");
    await approveEntries([old.entry.id, sept.entry.id], admin);
    await runMonthlyDealerPayout(PAYOUT_DAY);
    const [batch] = await batchesOf(dealer.id);
    expect(batch.totalPaise).toBe(20_000);
    const s = await dealerMonthStatement(dealer.id, SEPT);
    expect(s.payout!.entries.map((e) => e.shopName).sort()).toEqual(["July shop", "September shop"]);
    expect(s.totals.registrations).toBe(1);
  });

  it("a reversal owed back is carried forward, not paid as a negative payout", async () => {
    const { dealer } = await newDealer();
    const a = await registeredShop(dealer.id, new Date("2026-08-10T10:00:00+05:30"));
    await approveEntries([a.entry.id], admin);
    await closeCommissionMonth("2026-08", admin, new Date("2026-09-05T06:00:00+05:30"));
    const [aug] = await batchesOf(dealer.id);
    await markPayoutPaid(aug.id, "UTR-AUG-001", admin);
    // Reversed in September after it was paid: ₹100 owed back.
    await reverseEntry(a.entry.id, "fee refunded to the shop", admin);
    await db.update(dealerCommissionLedger).set({ createdAt: IN_SEPT }).where(eq(dealerCommissionLedger.kind, "REVERSAL"));

    const result = await runMonthlyDealerPayout(PAYOUT_DAY);
    expect(result).toMatchObject({ payouts: [], carried: [{ dealerId: dealer.id, netPaise: -10_000 }] });
    const s = await dealerMonthStatement(dealer.id, SEPT);
    expect(s.payout).toBeNull();
    expect(s.totals.carriedForwardPaise).toBe(10_000);
    expect(s.totals.reversedPaise).toBe(10_000);
  });

  it("a cancelled monthly draft's entries go into the next month's payout", async () => {
    const { dealer } = await newDealer();
    const a = await registeredShop(dealer.id, IN_SEPT);
    await approveEntries([a.entry.id], admin);
    await runMonthlyDealerPayout(PAYOUT_DAY);
    const [sept] = await batchesOf(dealer.id);
    await cancelPayout(sept.id, admin);
    await runMonthlyDealerPayout(new Date("2026-11-05T06:00:00+05:30"));
    const october = (await batchesOf(dealer.id)).find((b) => b.periodMonth === "2026-10")!;
    expect(october).toMatchObject({ status: "DRAFT", totalPaise: 10_000 });
  });

  it("nothing while the dealer programme is off", async () => {
    await setFeatureFlag("dealer_programme_enabled", { enabled: false, districtCodes: null }, "off (test)", admin);
    expect(await runMonthlyDealerPayout(PAYOUT_DAY)).toEqual({ skipped: "dealer programme off" });
    expect(await db.select().from(dealerCommissionMonths)).toHaveLength(0);
  });
});

describe("the statement", () => {
  it("lists the month's registrations and entries; the CSV is the dealer's own month only", async () => {
    const { user, dealer } = await newDealer();
    const other = await newDealer("Other Dealer");
    const a = await registeredShop(dealer.id, IN_SEPT, "Ganesh Traders");
    await registeredShop(other.dealer.id, IN_SEPT, "Not Yours Mart");
    await registeredShop(dealer.id, new Date("2026-10-03T10:00:00+05:30"), "October Mart");
    await approveEntries([a.entry.id], admin);
    await runMonthlyDealerPayout(PAYOUT_DAY);

    const s = await dealerMonthStatement(dealer.id, SEPT);
    expect(s).toMatchObject({ month: SEPT, label: "September 2026", closed: true });
    expect(s.registrations.map((r) => r.shopName)).toEqual(["Ganesh Traders"]);
    expect(s.totals).toMatchObject({ registrations: 1, earnedPaise: 10_000, awaitingApprovalPaise: 0 });
    expect(s.payout).toMatchObject({ status: "DRAFT", totalPaise: 10_000 });
    const csv = monthStatementCsv(s);
    expect(csv).toContain("September 2026");
    expect(csv).toContain("Ganesh Traders");
    expect(csv).not.toContain("Not Yours Mart");
    expect(csv).not.toContain("October Mart");

    signIn(user, "DEALER");
    const res = await call(statementGet, `/api/dealer/commission/statement?month=${SEPT}`);
    expect(res.status).toBe(200);
    const bad = await call(statementGet, "/api/dealer/commission/statement?month=2026-13");
    expect(bad.status).toBe(422);
  });

  it("paying a monthly draft records the UTR and tells the dealer, as before", async () => {
    const { user, dealer } = await newDealer();
    const a = await registeredShop(dealer.id, IN_SEPT);
    await approveEntries([a.entry.id], admin);
    await runMonthlyDealerPayout(PAYOUT_DAY);
    const [batch] = await batchesOf(dealer.id);
    await markPayoutPaid(batch.id, "UTR-SEPT-0001", admin);
    expect(await notices(user.id, "dealer.payout_paid")).toHaveLength(1);
    const s = await dealerMonthStatement(dealer.id, SEPT);
    expect(s.payout).toMatchObject({ status: "PAID", paymentReference: "UTR-SEPT-0001" });
  });
});

describe("admin", () => {
  it("closes a month now; an operator is refused; a month not over is refused; the payout day is validated", async () => {
    const { dealer } = await newDealer();
    const a = await registeredShop(dealer.id, IN_SEPT);
    await approveEntries([a.entry.id], admin);
    const operator = await createUser({ role: "OPERATOR" });

    signIn(operator, "OPERATOR");
    expect((await call(commissionPost, "/api/admin/dealer-commission", { method: "POST", body: { action: "closeMonth", month: SEPT } })).status).toBe(403);
    await expect(closeCommissionMonth(SEPT, { id: operator.id, role: "OPERATOR" })).rejects.toMatchObject({ status: 403 });

    await expect(closeCommissionMonth("2026-10", admin, PAYOUT_DAY)).rejects.toMatchObject({ status: 409 });
    signIn(admin, "ADMIN");
    const res = await call(commissionPost, "/api/admin/dealer-commission", { method: "POST", body: { action: "closeMonth", month: SEPT } });
    expect(res.status).toBe(200);
    expect(res.body.closed).toMatchObject({ month: SEPT, alreadyClosed: false });
    const [month] = await db.select().from(dealerCommissionMonths);
    expect(month).toMatchObject({ periodMonth: SEPT, closedBy: admin.id, payouts: 1, totalPaise: 10_000 });

    await expect(setCommissionSettings({ payoutDayOfMonth: 29 }, "end of month", admin)).rejects.toMatchObject({ status: 422 });
    await setCommissionSettings({ payoutDayOfMonth: 7 }, "owner moved it to the 7th", admin);
    const [{ day }] = (await db.execute(sql`select payout_day_of_month as day from dealer_commission_settings`)) as unknown as { day: number }[];
    expect(day).toBe(7);
  });
});
