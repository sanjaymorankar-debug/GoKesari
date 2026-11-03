/**
 * Dealer commission payouts and TDS (gap report Parts C and D), against real
 * PostgreSQL — both layouts (CI job test-split):
 *   C1 / C3  one payout per PAN per month, across roles and networks; carried per payee
 *   C2       held without PAN / verified bank / agreement (with the reminder), the minimum payout
 *   C4       maker-checker approval, automatic transfer (SANDBOX) with the UTR, failure → review
 *   C5 / C6  the statement email with its CSV, the four reports in CSV and XLSX
 *   D1 / D3  dated rows: an unconfirmed row blocks paying until an admin overrides; the CA confirms;
 *            CATCH_UP vs EXCESS_ONLY; D2 a nil certificate; D4 the CA role's permissions
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { AGENT_AGREEMENT_VERSION } from "@/lib/dealer-tiers";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import {
  commissionTdsRates,
  dealerCommissionLedger,
  dealerCommissionMonths,
  dealerPayoutBatches,
  dealerSalespeople,
  dealers,
  documentEmails,
  notifications,
} from "@/server/db/schema";
import { approvePayoutBatch, retryFlaggedPayout } from "@/server/dealers/auto-payout";
import { createPayoutBatch, markPayoutPaid } from "@/server/dealers/commission";
import { closeCommissionMonth, dealerMonthStatement, dealerStatementForBatch } from "@/server/dealers/monthly-payout";
import { payoutReport, payoutReportFile } from "@/server/dealers/payout-reports";
import { renderDocumentAttachments } from "@/server/documents/email";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { RULES } from "@/server/config/rules";
import { addTdsCertificate, deduction, overrideTdsBlock, setCommissionTdsConfirmation } from "@/server/tax/commission-tds";
import { createUser, resetDatabase } from "../helpers/fixtures";

let admin: { id: string; role: "ADMIN" };
let admin2: { id: string; role: "ADMIN" };
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
});

async function dealer(over: Partial<typeof dealers.$inferInsert> = {}) {
  const user = await createUser({ role: "DEALER" });
  counter += 1;
  const [d] = await db
    .insert(dealers)
    .values({ userId: user.id, legalName: `Dealer ${counter}`, contactName: "D", dealerType: "PROPRIETORSHIP", status: "APPROVED", panHash: `pan-${counter}-${user.id}`, panLast4: "234F", bankStatus: "VERIFIED", bankAccountEnc: null, ...over })
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

/** An APPROVED earning of `amount` for a payee, dated in this month (a target bonus: no shop needed). */
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

describe("C1 / C3: one payout per PAN per month", () => {
  it("a person who is a main dealer and a team member elsewhere (same PAN) gets one payout; each statement shows it", async () => {
    const x = await dealer({ panHash: "same-pan" });
    const y = await dealer();
    const m = await memberOf(y.id, { panHash: "same-pan" });
    await earn(x.id, null, 30_000);
    await earn(y.id, m.id, 20_000);
    await earn(y.id, null, 10_000);
    const result = await closeCommissionMonth(month, admin, afterMonth);
    expect(result.payouts.map((p) => p.totalPaise).sort()).toEqual([10_000, 50_000]);
    const [merged] = await db.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.payeePanHash, "same-pan"));
    expect(merged).toMatchObject({ totalPaise: 50_000, periodMonth: month });
    expect((await dealerMonthStatement(x.id, month)).payout?.id).toBe(merged.id);
    expect((await dealerMonthStatement(y.id, month, m.id)).payout?.id).toBe(merged.id);
  });
});

describe("C2: held payees, the reminder, the minimum", () => {
  it("no verified bank: carried with the reason, reminded; below the minimum: carried", async () => {
    await setRule("dealerPayouts", { minPayoutPaise: 50_000, reminderEnabled: true }, admin);
    clearRuleCache();
    const d = await dealer();
    const user = await createUser({ role: "DEALER" });
    const held = await memberOf(d.id, { bankStatus: "PENDING", userId: user.id });
    await earn(d.id, held.id, 80_000);
    await earn(d.id, null, 20_000);
    const result = await closeCommissionMonth(month, admin, afterMonth);
    expect(result.payouts).toHaveLength(0);
    expect(result.carried.find((c) => c.memberId === held.id)).toMatchObject({ netPaise: 80_000, missing: ["verified bank account"] });
    expect(result.carried.find((c) => c.memberId === null)?.reason).toMatch(/below the ₹500 minimum/);
    const [notice] = await db.select().from(notifications).where(and(eq(notifications.userId, user.id), eq(notifications.type, "dealer.payout_held")));
    expect(notice.body).toContain("verified bank account");
    // Next month, with the bank verified, it is paid with that month.
    const [pending] = await payoutReport("pending", { month }).then((t) => t.rows);
    expect(pending).toBeTruthy();
  });
});

describe("C4: maker-checker and the automatic transfer", () => {
  it("the drafting admin cannot approve; another can; with the rule on the SANDBOX pays and records the UTR", async () => {
    const d = await dealer({ bankAccountEnc: (await import("@/lib/pan-crypto")).encryptSecret("123456789012"), bankIfsc: "SBIN0001234", bankHolderName: "Dealer" });
    await earn(d.id, null, 30_000);
    const batch = await createPayoutBatch(d.id, admin);
    await expect(approvePayoutBatch(batch.id, admin)).rejects.toThrow(/maker-checker/);
    await setRule("dealerAutoPayout", { ...RULES.dealerAutoPayout.defaults, enabled: true }, admin);
    clearRuleCache();
    const paid = await approvePayoutBatch(batch.id, admin2);
    expect(paid).toMatchObject({ status: "PAID", provider: "SANDBOX", approvedBy: admin2.id });
    expect(paid.paymentReference).toMatch(/\w{6,}/);
    const entries = await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.payoutBatchId, batch.id));
    expect(entries.every((e) => e.status === "PAID")).toBe(true);
  });

  it("a failing transfer is retried and then flagged for finance; paying by hand still works", async () => {
    await setRule("dealerAutoPayout", { ...RULES.dealerAutoPayout.defaults, enabled: true, maxRetries: 0 }, admin);
    clearRuleCache();
    const d = await dealer({ bankAccountEnc: (await import("@/lib/pan-crypto")).encryptSecret("123456789012"), bankIfsc: "SBIN0001234", bankHolderName: "Dealer" });
    await earn(d.id, null, 30_098); // …98 paise: the sandbox bank always fails
    const batch = await createPayoutBatch(d.id, admin);
    const failed = await approvePayoutBatch(batch.id, admin2);
    expect(failed).toMatchObject({ status: "FAILED", needsReview: true });
    expect(failed.failureReason).toMatch(/offline/);
    const again = await retryFlaggedPayout(batch.id, admin2);
    expect(again.status).toBe("FAILED");
    await expect(markPayoutPaid(batch.id, "NEFT-BY-HAND-1", admin)).resolves.toMatchObject({ status: "PAID", paymentReference: "NEFT-BY-HAND-1" });
  });
});

describe("C5 / C6: statement email and reports", () => {
  it("the month's payout is emailed with its statement CSV; the four reports export as CSV and XLSX", async () => {
    const d = await dealer();
    await earn(d.id, null, 30_000);
    const result = await closeCommissionMonth(month, admin, afterMonth);
    const batchId = result.payouts[0].batchId;
    const [email] = await db.select().from(documentEmails).where(and(eq(documentEmails.docType, "DEALER_STATEMENT"), eq(documentEmails.docId, batchId)));
    expect(email).toBeTruthy();
    const rendered = await renderDocumentAttachments("DEALER_STATEMENT", batchId);
    expect(rendered?.attachments[0].filename).toBe(`gokesari-commission-${month}.csv`);
    expect((await dealerStatementForBatch(batchId))?.csv).toContain("Net paid to your bank (Rs)");
    for (const report of ["summary", "lines", "pending", "failed"] as const) {
      const csv = await payoutReportFile(report, { month }, "csv");
      expect(csv.body.subarray(3).toString("utf8").split("\r\n")[0].length).toBeGreaterThan(10);
      const xlsx = await payoutReportFile(report, { month }, "xlsx");
      expect(xlsx.body.subarray(0, 2).toString("latin1")).toBe("PK");
    }
    const summary = await payoutReport("summary", { month, role: "MAIN_DEALER" });
    expect(summary.rows[0]).toEqual(expect.arrayContaining([batchId, month, "Main dealer", "234F", 300, 0]));
  });
});

describe("D1 / D3 / D2 / D4: dated TDS rows", () => {
  it("an unconfirmed row blocks paying until an admin overrides; once the CA confirms, the next payout is not blocked", async () => {
    await setRule("dealerPayoutTds", { enabled: true, rateBp: 200, annualThresholdPaise: 2_000_000 }, admin);
    clearRuleCache();
    await db.update(commissionTdsRates).set({ thresholdPaise: 10_000 }).where(eq(commissionTdsRates.panStatus, "PAN_OK"));
    const d = await dealer();
    await earn(d.id, null, 50_000);
    const batch = await createPayoutBatch(d.id, admin);
    expect(batch).toMatchObject({ tdsPaise: 1_000, tdsRateBp: 200, tdsFlag: "UNCONFIRMED_RATE" });
    expect(batch.tdsSection).toMatch(/194H/);
    await expect(markPayoutPaid(batch.id, "UTR-1", admin)).rejects.toMatchObject({ details: { reason: "TDS_UNCONFIRMED" } });
    await expect(approvePayoutBatch(batch.id, admin2)).rejects.toThrow(/not confirmed by the CA/);
    await overrideTdsBlock(batch.id, "owner asked to pay before the CA reply", admin);
    await expect(markPayoutPaid(batch.id, "UTR-1", admin)).resolves.toMatchObject({ status: "PAID" });

    const ca = { id: (await createUser({ role: "CA" as never })).id, role: "CA" as const };
    const [row] = await db.select().from(commissionTdsRates).where(and(eq(commissionTdsRates.payeeType, "ANY"), eq(commissionTdsRates.panStatus, "PAN_OK")));
    await expect(setCommissionTdsConfirmation(row.id, true, admin)).rejects.toThrow(/Only the CA/);
    await setCommissionTdsConfirmation(row.id, true, ca);
    await earn(d.id, null, 50_000);
    const next = await createPayoutBatch(d.id, admin);
    // Catch-up: the year is ₹1,000 → 2% = ₹20, less ₹10 already deducted.
    expect(next).toMatchObject({ tdsPaise: 1_000, tdsFlag: null });
  });

  it("CATCH_UP vs EXCESS_ONLY, and a nil certificate", () => {
    const rate = { rateBp: 200, thresholdPaise: 2_000_000 };
    expect(deduction({ grossPaise: 1_000_000, yearGrossBeforePaise: 1_500_000, yearTdsBeforePaise: 0, rate: { ...rate, mode: "CATCH_UP" } })).toBe(50_000);
    expect(deduction({ grossPaise: 1_000_000, yearGrossBeforePaise: 1_500_000, yearTdsBeforePaise: 0, rate: { ...rate, mode: "EXCESS_ONLY" } })).toBe(10_000);
    expect(deduction({ grossPaise: 1_000_000, yearGrossBeforePaise: 1_500_000, yearTdsBeforePaise: 0, rate: { ...rate, mode: "CATCH_UP" }, certificate: { rateBp: 0, limitPaise: 2_500_000 } })).toBe(0);
    expect(deduction({ grossPaise: 1_000_000, yearGrossBeforePaise: 1_500_000, yearTdsBeforePaise: 0, rate: { ...rate, mode: "CATCH_UP" }, certificate: { rateBp: 0, limitPaise: 1_800_000 } })).toBe(14_000);
  });

  it("a payee's nil certificate applies to their payout", async () => {
    await setRule("dealerPayoutTds", { enabled: true, rateBp: 200, annualThresholdPaise: 2_000_000 }, admin);
    clearRuleCache();
    await db.update(commissionTdsRates).set({ thresholdPaise: 0, confirmedByCa: true }).where(eq(commissionTdsRates.panStatus, "PAN_OK"));
    const d = await dealer();
    await addTdsCertificate({ panHash: d.panHash!, payeeLabel: d.legalName, certificateNumber: "LDC/2026/1", rateBp: 0, validFrom: "2026-04-01", validTo: "2027-03-31" }, admin);
    await earn(d.id, null, 50_000);
    const batch = await createPayoutBatch(d.id, admin);
    expect(batch).toMatchObject({ tdsPaise: 0 });
    expect(batch.tdsCertificateId).toBeTruthy();
  });

  it("the CA reads payouts and keeps TDS records, but never approves or pays", () => {
    expect(can("CA", PERMISSIONS.DEALER_PAYOUTS_READ)).toBe(true);
    expect(can("CA", PERMISSIONS.COMMISSION_TDS_MANAGE)).toBe(true);
    expect(can("CA", PERMISSIONS.STATUTORY_MANAGE)).toBe(true);
    expect(can("CA", PERMISSIONS.REFERRAL_MANAGE)).toBe(false);
    expect(can("OPERATOR", PERMISSIONS.COMMISSION_TDS_MANAGE)).toBe(false);
  });
});
