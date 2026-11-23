/**
 * Dealer payouts (23-Nov-2026): payee checks for every payee, approval before payment, TDS kept current.
 *   - month close holds a dealer / franchise owner and a team member without PAN or verified bank, and
 *     tells them in the app and by e-mail; the /dealer banner view shows what is missing and the amount
 *   - markPayoutPaid refuses a draft, a payee who is not ready, and TDS worked out while the rule was off
 *   - a TDS override and the approval are made by two different admins
 *   - a PAN added mid-year: the earlier PAN-less payouts count towards the PAN's year
 *   - the reports of payees not ready and the TDS catch-up dry run
 *   - migration 0182 turns a stored `enforcePayeeChecks: false` on
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { AGENT_AGREEMENT_VERSION } from "@/lib/dealer-tiers";
import { db } from "@/server/db";
import { auditLogs, commissionTdsRates, dealerCommissionLedger, dealerCommissionMonths, dealerSalespeople, dealers, notificationDeliveries, platformSettings } from "@/server/db/schema";
import { approvePayoutBatch } from "@/server/dealers/auto-payout";
import { createPayoutBatch, heldPayoutView, markPayoutPaid } from "@/server/dealers/commission";
import { closeCommissionMonth } from "@/server/dealers/monthly-payout";
import { payoutReport } from "@/server/dealers/payout-reports";
import { clearRuleCache, getRule, setRule } from "@/server/services/settings";
import { overrideTdsBlock } from "@/server/tax/commission-tds";
import { createUser, resetDatabase } from "../helpers/fixtures";

let admin: { id: string; role: "ADMIN" };
let admin2: { id: string; role: "ADMIN" };
let admin3: { id: string; role: "ADMIN" };
let counter = 0;
const month = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
const afterMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 2));

beforeEach(async () => {
  await resetDatabase();
  await db.delete(dealerCommissionLedger);
  await db.delete(dealerCommissionMonths);
  for (const key of ["dealerPayoutTds", "dealerPayouts", "dealerAutoPayout"]) await db.execute(sql`delete from platform_settings where key = ${key}`);
  await db.execute(sql`delete from commission_tds_rates where effective_from <> date '2026-04-01'`);
  await db.execute(sql`update commission_tds_rates set threshold_paise = case when pan_status = 'PAN_OK' then 2000000 else 0 end, confirmed_by_ca = false, mode = 'CATCH_UP', effective_to = null`);
  await db.execute(sql`delete from commission_tds_certificates`);
  clearRuleCache();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  admin2 = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  admin3 = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
});

async function dealer(over: Partial<typeof dealers.$inferInsert> = {}) {
  const user = await createUser({ role: "DEALER" });
  counter += 1;
  const [d] = await db
    .insert(dealers)
    .values({ userId: user.id, legalName: `Dealer ${counter}`, contactName: "D", dealerType: "PROPRIETORSHIP", status: "APPROVED", panHash: `pan-${counter}-${user.id}`, panLast4: "234F", bankStatus: "VERIFIED", ...over })
    .returning();
  return d;
}

async function memberOf(dealerId: string, over: Partial<typeof dealerSalespeople.$inferInsert> = {}) {
  counter += 1;
  const [m] = await db
    .insert(dealerSalespeople)
    .values({ dealerId, employeeId: `E${counter}`, name: `Member ${counter}`, panHash: `mpan-${counter}`, panLast4: "999Z", bankStatus: "VERIFIED", agreementVersion: AGENT_AGREEMENT_VERSION, ...over })
    .returning();
  return m;
}

async function earn(dealerId: string, memberId: string | null, amount: number) {
  counter += 1;
  await db.insert(dealerCommissionLedger).values({
    dealerId,
    payeeMemberId: memberId,
    milestone: "MONTHLY",
    entryType: "BONUS",
    accrualKey: `T:${counter}:${dealerId}`,
    amountPaise: amount,
    basePaise: amount,
    status: "APPROVED",
    createdAt: new Date(Date.now() - 60_000),
  });
}

/** TDS on, with CA-confirmed rows (PAN 2% above `thresholdPaise`, no PAN 20% from ₹0). */
async function tdsOn(thresholdPaise: number) {
  await setRule("dealerPayoutTds", { enabled: true, rateBp: 200, annualThresholdPaise: thresholdPaise }, admin);
  await db.update(commissionTdsRates).set({ thresholdPaise, confirmedByCa: true }).where(eq(commissionTdsRates.panStatus, "PAN_OK"));
  await db.update(commissionTdsRates).set({ confirmedByCa: true }).where(eq(commissionTdsRates.panStatus, "NO_PAN"));
  clearRuleCache();
}

describe("checks for every payee", () => {
  it("the checks are on by default", async () => {
    expect((await getRule("dealerPayouts")).enforcePayeeChecks).toBe(true);
  });

  it("month close holds a dealer (or franchise owner) and a team member who are not ready, and tells them by app and e-mail", async () => {
    const owner = await createUser({ role: "DEALER" });
    const noPan = await dealer({ panHash: null, panLast4: null, userId: owner.id });
    const memberUser = await createUser({ role: "DEALER" });
    const ready = await dealer();
    const unverified = await memberOf(ready.id, { bankStatus: "PENDING", userId: memberUser.id });
    await earn(noPan.id, null, 80_000);
    await earn(ready.id, unverified.id, 40_000);
    await earn(ready.id, null, 30_000);
    const result = await closeCommissionMonth(month, admin, afterMonth);
    expect(result.payouts.map((p) => p.dealerId)).toEqual([ready.id]);
    expect(result.carried.find((c) => c.dealerId === noPan.id)).toMatchObject({ netPaise: 80_000, missing: ["PAN"] });
    expect(result.carried.find((c) => c.memberId === unverified.id)).toMatchObject({ netPaise: 40_000, missing: ["verified bank account"] });
    const email = await db.select().from(notificationDeliveries).where(and(eq(notificationDeliveries.userId, owner.id), eq(notificationDeliveries.type, "dealer.payout_held"), eq(notificationDeliveries.channel, "EMAIL")));
    expect(email).toHaveLength(1);
    // The /dealer banner: what is missing and the amount waiting.
    expect(await heldPayoutView(noPan.id, null)).toEqual({ missing: ["PAN"], heldPaise: 80_000 });
    expect(await heldPayoutView(ready.id, unverified.id)).toEqual({ missing: ["verified bank account"], heldPaise: 40_000 });
    expect(await heldPayoutView(ready.id, null)).toBeNull();
  });

  it("the report lists payees not ready with what they are owed", async () => {
    const noBank = await dealer({ bankStatus: "PENDING" });
    await earn(noBank.id, null, 55_000);
    await earn((await dealer()).id, null, 10_000);
    const table = await payoutReport("notready");
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toEqual([noBank.legalName, "Main dealer", noBank.legalName, "verified bank account", 550, 0, 550, "held"]);
  });
});

describe("paying by hand", () => {
  it("refuses a draft: a second admin approves first", async () => {
    const d = await dealer();
    await earn(d.id, null, 30_000);
    const batch = await createPayoutBatch(d.id, admin);
    await expect(markPayoutPaid(batch.id, "UTR-DRAFT", admin)).rejects.toMatchObject({ details: { reason: "NOT_APPROVED" } });
    await approvePayoutBatch(batch.id, admin2);
    await expect(markPayoutPaid(batch.id, "UTR-DRAFT", admin)).resolves.toMatchObject({ status: "PAID" });
  });

  it("refuses a dealer whose PAN or bank is gone after approval", async () => {
    const d = await dealer();
    await earn(d.id, null, 30_000);
    const batch = await createPayoutBatch(d.id, admin);
    await approvePayoutBatch(batch.id, admin2);
    await db.update(dealers).set({ bankStatus: "PENDING" }).where(eq(dealers.id, d.id));
    await expect(markPayoutPaid(batch.id, "UTR-X", admin)).rejects.toMatchObject({ details: { reason: "PAYEE_NOT_READY" } });
  });

  it("refuses a payout whose TDS was worked out while the rule was off", async () => {
    const d = await dealer();
    await earn(d.id, null, 30_000);
    const batch = await createPayoutBatch(d.id, admin);
    expect(batch.tdsPaise).toBe(0);
    await approvePayoutBatch(batch.id, admin2);
    await tdsOn(0);
    await expect(markPayoutPaid(batch.id, "UTR-STALE", admin)).rejects.toMatchObject({ details: { reason: "TDS_STALE" } });
    // A draft made with TDS off is not approved once it is on, either.
    await earn(d.id, null, 20_000);
    await setRule("dealerPayoutTds", { enabled: false, rateBp: 200, annualThresholdPaise: 0 }, admin);
    clearRuleCache();
    const second = await createPayoutBatch(d.id, admin);
    await tdsOn(0);
    await expect(approvePayoutBatch(second.id, admin2)).rejects.toMatchObject({ details: { reason: "TDS_STALE" } });
  });

  it("a TDS override and the approval are two different admins", async () => {
    await setRule("dealerPayoutTds", { enabled: true, rateBp: 200, annualThresholdPaise: 0 }, admin);
    clearRuleCache();
    const d = await dealer();
    await earn(d.id, null, 30_000);
    const batch = await createPayoutBatch(d.id, admin);
    expect(batch.tdsFlag).toBe("UNCONFIRMED_RATE");
    await overrideTdsBlock(batch.id, "owner asked to pay before the CA reply", admin2);
    await expect(approvePayoutBatch(batch.id, admin2)).rejects.toThrow(/overrode/);
    await approvePayoutBatch(batch.id, admin3);
    await expect(overrideTdsBlock(batch.id, "again after approval", admin3)).rejects.toThrow();
    await expect(markPayoutPaid(batch.id, "UTR-OVR", admin)).resolves.toMatchObject({ status: "PAID" });
  });
});

describe("TDS per PAN", () => {
  it("a PAN added mid-year: the earlier PAN-less payouts count towards the year", async () => {
    // Paid without a PAN while the checks were off (rule switched off by an admin), TDS off.
    await setRule("dealerPayouts", { enforcePayeeChecks: false, minPayoutPaise: 0, reminderEnabled: true }, admin);
    clearRuleCache();
    const d = await dealer({ panHash: null, panLast4: null });
    await earn(d.id, null, 1_500_000);
    const early = await createPayoutBatch(d.id, admin);
    expect(early.payeePanHash).toBeNull();
    await approvePayoutBatch(early.id, admin2);
    await markPayoutPaid(early.id, "UTR-EARLY", admin);
    // The PAN is added; TDS goes on: ₹15,000 earlier + ₹10,000 now = ₹25,000 > ₹20,000 → 2% of the year = ₹500.
    await db.update(dealers).set({ panHash: `pan-late-${d.id}`, panLast4: "777K" }).where(eq(dealers.id, d.id));
    await tdsOn(2_000_000);
    await earn(d.id, null, 1_000_000);
    const later = await createPayoutBatch(d.id, admin);
    expect(later).toMatchObject({ totalPaise: 1_000_000, tdsPaise: 50_000 });
  });

  it("no PAN: 20% from the first rupee", async () => {
    await setRule("dealerPayouts", { enforcePayeeChecks: false, minPayoutPaise: 0, reminderEnabled: true }, admin);
    await tdsOn(2_000_000);
    const d = await dealer({ panHash: null, panLast4: null });
    await earn(d.id, null, 100_000);
    expect(await createPayoutBatch(d.id, admin)).toMatchObject({ tdsPaise: 20_000, tdsRateBp: 2000 });
  });

  it("the catch-up dry run shows each PAN's year, the TDS deducted and the shortfall", async () => {
    const d = await dealer();
    for (const ref of ["UTR-M1", "UTR-M2", "UTR-M3"]) {
      await earn(d.id, null, 800_000);
      const b = await createPayoutBatch(d.id, admin);
      await approvePayoutBatch(b.id, admin2);
      await markPayoutPaid(b.id, ref, admin);
    }
    await db.update(commissionTdsRates).set({ thresholdPaise: 2_000_000 }).where(eq(commissionTdsRates.panStatus, "PAN_OK"));
    const table = await payoutReport("tdscatchup");
    const row = table.rows.find((r) => r[0] === d.legalName)!;
    // Three months of ₹8,000 with no TDS: ₹24,000 > ₹20,000 → 2% = ₹480 short.
    expect(row.slice(3, 6)).toEqual([3, 24_000, 0]);
    expect(row.slice(7)).toEqual([480, 480]);
  });
});

describe("migration 0182", () => {
  it("turns a stored enforcePayeeChecks false on, keeps the other values, and logs it", async () => {
    await db.insert(platformSettings).values({ key: "dealerPayouts", value: { enforcePayeeChecks: false, minPayoutPaise: 10_000, reminderEnabled: false } });
    const file = readFileSync(path.join(process.cwd(), "drizzle/0182_dealer_payee_checks_on.sql"), "utf8");
    await db.execute(sql.raw(file));
    const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, "dealerPayouts"));
    expect(row.value).toEqual({ enforcePayeeChecks: true, minPayoutPaise: 10_000, reminderEnabled: false });
    const logged = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "platform_setting"), eq(auditLogs.entityId, "dealerPayouts")));
    expect(logged).toHaveLength(1);
    // Run again: nothing more to change.
    await db.execute(sql.raw(file));
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "platform_setting"), eq(auditLogs.entityId, "dealerPayouts")))).toHaveLength(1);
  });
});
