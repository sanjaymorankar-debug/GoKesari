/**
 * RBAC v2 Phase 3 bank-statement reconciliation (docs/rbac/03-phase3-accounting.md §Bank reconciliation):
 * reading bank files, automatic matching by UTR + amount, suggestions, manual match / exclude / undo,
 * one record ↔ one bank line, Accountant → CA sign-off, final once reconciled (DB triggers).
 */
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { featureFlags, finBankStatementLines, finBankStatements, shopSettlements } from "@/server/db/schema";
import { decideApproval } from "@/server/approvals";
import {
  autoMatchStatement,
  deleteStatement,
  excludeLine,
  getStatement,
  importStatement,
  matchLine,
  submitStatement,
  unmatchedBookItems,
  unmatchLine,
  withdrawStatement,
} from "@/server/rbac-accounting/bank-reconciliation";
import { parseBankStatementFile, parseStatementAmount, parseStatementDate, referenceTokens } from "@/server/rbac-accounting/bank-statement-file";
import { createJournalDraft, submitJournal } from "@/server/rbac-accounting/journals";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

vi.mock("@/server/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock("@/server/auth", () => ({ auth: async () => null, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

async function flag(enabled: boolean) {
  await db.insert(featureFlags).values({ key: "rbac_v2_accounting", enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
  clearFeatureFlagCache();
}

async function people() {
  const acc = await createUser({ role: "ACCOUNTANT" });
  const ca = await createUser({ role: "CA" });
  return { accountant: { id: acc.id, role: "ACCOUNTANT" as const }, ca: { id: ca.id, role: "CA" as const } };
}

/** A shop settlement marked PAID with a bank reference, paid on an IST date. */
async function paidSettlement(amountPaise: number, utr: string | null, paidOn = "2026-11-05") {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: `Shop ${utr ?? amountPaise}` });
  const [row] = await db
    .insert(shopSettlements)
    .values({
      shopId: shop.id,
      periodStart: "2026-10-27",
      periodEnd: "2026-11-03",
      orderCount: 3,
      goodsPaise: amountPaise,
      commissionPaise: 0,
      refundsPaise: 0,
      adjustmentsPaise: 0,
      netPayablePaise: amountPaise,
      status: "PAID",
      paymentReference: utr,
      paidAt: new Date(`${paidOn}T11:00:00+05:30`),
    })
    .returning();
  return row;
}

/** HDFC-style export: account details on top, then the table, then a footer. */
function hdfcCsv(rows: [string, string, string, string, string, string][], opening = 100_000_00) {
  let balance = opening;
  const body = rows.map(([date, narration, ref, withdrawal, deposit, valueDate]) => {
    balance += Math.round(Number(deposit || 0) * 100) - Math.round(Number(withdrawal || 0) * 100);
    return [date, `"${narration}"`, ref, valueDate || date, withdrawal, deposit, (balance / 100).toFixed(2)].join(",");
  });
  return Buffer.from(
    [
      "HDFC BANK Ltd.,,,,,,",
      "Account No :,XXXXXXXX1234,,,,,",
      "Statement From :,01/11/2026,To :,30/11/2026,,,",
      ",,,,,,",
      "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
      ...body,
      ",,,,,,",
      "STATEMENT SUMMARY,,,,,,",
    ].join("\n"),
  );
}

beforeEach(async () => {
  await resetDatabase();
  await flag(true);
});

describe("reading bank files", () => {
  it("reads dates, amounts and references the way Indian banks write them", () => {
    expect(parseStatementDate("05/11/26")).toBe("2026-11-05");
    expect(parseStatementDate("05-11-2026")).toBe("2026-11-05");
    expect(parseStatementDate("05-Nov-2026")).toBe("2026-11-05");
    expect(parseStatementDate("5 Nov 2026")).toBe("2026-11-05");
    expect(parseStatementDate("2026-11-05")).toBe("2026-11-05");
    expect(parseStatementDate("31/02/2026")).toBeNull();
    expect(parseStatementAmount("1,23,456.78")).toBe(12_345_678);
    expect(parseStatementAmount("₹ 120")).toBe(12_000);
    expect(parseStatementAmount("(50.00)")).toBe(-5_000);
    expect(parseStatementAmount("250.00 Dr")).toBe(-25_000);
    expect(parseStatementAmount("")).toBeNull();
    expect(() => parseStatementAmount("12a")).toThrow(/not an amount/);
    expect(referenceTokens(null, "NEFT DR-HDFC0000001-GOKESARI SHOP-NETBANK, MUM-N312262345678901-PAYOUT")).toContain("N312262345678901");
  });

  it("finds the header under the account details, skips the footer, checks the running balance", async () => {
    const file = hdfcCsv([
      ["03/11/26", "NEFT DR-UTR123456789-SHOP A", "UTR123456789", "1500.00", "", ""],
      ["04/11/26", "CASHFREE SETTLEMENT", "CF998877", "", "25000.00", ""],
    ]);
    const parsed = await parseBankStatementFile(file, "nov.csv");
    expect(parsed.errors).toEqual([]);
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0]).toMatchObject({ txnDate: "2026-11-03", debitPaise: 150_000, creditPaise: 0, reference: "UTR123456789" });
    expect(parsed.openingBalancePaise).toBe(10_000_000);
    expect(parsed.closingBalancePaise).toBe(10_000_000 - 150_000 + 2_500_000);
    expect(parsed.warnings).toEqual([]);

    const gap = Buffer.from(file.toString().replace("123500.00", "123400.00"));
    expect((await parseBankStatementFile(gap, "gap.csv")).warnings.join(" ")).toMatch(/does not follow/);
  });

  it("puts a newest-first statement in date order; one Amount column with Dr/Cr; reports bad rows by number", async () => {
    const csv = ["Txn Date,Description,Ref No,Amount,Dr/Cr,Balance", "06-Nov-2026,Interest,,10.00,CR,1010.00", "05-Nov-2026,Charges,,5.00,DR,1000.00"].join("\n");
    const parsed = await parseBankStatementFile(Buffer.from(csv), "sbi.csv");
    expect(parsed.lines.map((l) => l.txnDate)).toEqual(["2026-11-05", "2026-11-06"]);
    expect(parsed.lines[0].debitPaise).toBe(500);
    expect(parsed.lines[1].creditPaise).toBe(1_000);
    expect(parsed.warnings.join(" ")).toMatch(/newest first/);

    const bad = ["Date,Narration,Debit,Credit", "05/11/2026,ok,10,", "yesterday,bad date,10,", "06/11/2026,both,10,20", "07/11/2026,none,,"].join("\n");
    const result = await parseBankStatementFile(Buffer.from(bad), "bad.csv");
    expect(result.errors.map((e) => e.row)).toEqual([3, 4, 5]);
  });

  it("reads an Excel statement with real date cells", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Statement");
    ws.addRow(["ICICI Bank"]);
    ws.addRow(["Transaction Date", "Transaction Remarks", "Withdrawal Amount (INR )", "Deposit Amount (INR )", "Balance (INR )"]);
    ws.addRow([new Date(Date.UTC(2026, 10, 7)), "IMPS/P2A/632712345678/RIDER", 250, null, 750]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const parsed = await parseBankStatementFile(buf, "icici.xlsx");
    expect(parsed.errors).toEqual([]);
    expect(parsed.lines[0]).toMatchObject({ txnDate: "2026-11-07", debitPaise: 25_000 });
    expect(referenceTokens(parsed.lines[0].reference, parsed.lines[0].description)).toContain("632712345678");
  });
});

describe("import and automatic matching", () => {
  it("is for the Accountant only, behind rbac_v2_accounting", async () => {
    const { accountant, ca } = await people();
    const file = hdfcCsv([["03/11/26", "x", "", "1.00", "", ""]]);
    await expect(importStatement({ accountLabel: "HDFC current ••1234", file, filename: "a.csv" }, ca)).rejects.toThrow(/Only an Accountant/);
    await flag(false);
    await expect(importStatement({ accountLabel: "HDFC current ••1234", file, filename: "a.csv" }, accountant)).rejects.toThrow(/not available/);
  });

  it("matches by UTR + amount, suggests the rest, never matches a credit to a payout", async () => {
    const { accountant } = await people();
    const exact = await paidSettlement(150_000, "N312262345678901", "2026-11-03");
    const wrongAmount = await paidSettlement(99_900, "UTR555500001111", "2026-11-04");
    const noRef = await paidSettlement(42_000, null, "2026-11-05");
    await paidSettlement(80_000, "UTR777700002222", "2026-11-05");
    const file = hdfcCsv([
      ["03/11/26", "NEFT DR-HDFC0000001-SHOP-N312262345678901", "", "1500.00", "", ""],
      ["04/11/26", "NEFT DR UTR555500001111", "UTR555500001111", "1000.00", "", ""],
      ["06/11/26", "IMPS PAYOUT", "", "420.00", "", ""],
      ["06/11/26", "NEFT CR UTR777700002222 RETURNED", "", "", "800.00", ""],
    ]);
    const result = await importStatement({ accountLabel: "HDFC current ••1234", file, filename: "nov.csv" }, accountant);
    expect(result).toMatchObject({ matched: 1, suggested: 2, unmatched: 3 });

    const { lines } = await getStatement(result.statement.id);
    expect(lines[0]).toMatchObject({ status: "MATCHED", matchKind: "SHOP_SETTLEMENT", matchId: exact.id, matchMethod: "AUTO" });
    expect(lines[1].status).toBe("UNMATCHED");
    expect(lines[1].suggestion).toMatchObject({ id: wrongAmount.id });
    expect(lines[1].suggestion?.why).toMatch(/amount differs/);
    expect(lines[2].suggestion).toMatchObject({ id: noRef.id });
    expect(lines[2].suggestion?.why).toMatch(/Same amount/);
    expect(lines[3]).toMatchObject({ status: "UNMATCHED", suggestion: null });
  });

  it("refuses the same file twice, an overlapping statement and a full account number", async () => {
    const { accountant } = await people();
    const file = hdfcCsv([["03/11/26", "x", "", "1.00", "", ""]]);
    const first = await importStatement({ accountLabel: "HDFC current ••1234", file, filename: "a.csv" }, accountant);
    await expect(importStatement({ accountLabel: "Other", file, filename: "b.csv" }, accountant)).rejects.toThrow(new RegExp(`already imported as ${first.statement.statementNumber}`));
    const overlapping = hdfcCsv([["03/11/26", "y", "", "2.00", "", ""]]);
    await expect(importStatement({ accountLabel: "hdfc CURRENT ••1234", file: overlapping, filename: "c.csv" }, accountant)).rejects.toThrow(/already covers/);
    await expect(importStatement({ accountLabel: "HDFC 50100123456789", file: overlapping, filename: "c.csv" }, accountant)).rejects.toThrow(/last 4 digits/);
    // Another account may cover the same dates.
    await expect(importStatement({ accountLabel: "ICICI ••9876", file: overlapping, filename: "c.csv" }, accountant)).resolves.toBeTruthy();
  });

  it("refuses a file with bad rows and imports nothing", async () => {
    const { accountant } = await people();
    const csv = ["Date,Narration,Debit,Credit", "05/11/2026,ok,10,", "bad,row,10,"].join("\n");
    await expect(importStatement({ accountLabel: "HDFC ••1234", file: Buffer.from(csv), filename: "x.csv" }, accountant)).rejects.toThrow(/1 row has a problem/);
    expect(await db.select().from(finBankStatements)).toHaveLength(0);
  });
});

describe("manual matching", () => {
  it("matches only an equal amount, one record to one line across statements; exclude needs a reason; undo", async () => {
    const { accountant } = await people();
    const s1 = await paidSettlement(30_000, null, "2026-11-10");
    const first = await importStatement({ accountLabel: "HDFC ••1234", file: hdfcCsv([["10/11/26", "PAYOUT A", "", "300.00", "", ""], ["10/11/26", "PAYOUT B", "", "301.00", "", ""]]), filename: "a.csv" }, accountant);
    const { lines } = await getStatement(first.statement.id);
    await expect(matchLine(lines[1].id, { kind: "SHOP_SETTLEMENT", id: s1.id }, accountant)).rejects.toThrow(/amounts differ/);
    await matchLine(lines[0].id, { kind: "SHOP_SETTLEMENT", id: s1.id }, accountant);

    const second = await importStatement({ accountLabel: "ICICI ••9876", file: hdfcCsv([["10/11/26", "PAYOUT A again", "", "300.00", "", ""]]), filename: "b.csv" }, accountant);
    const [other] = (await getStatement(second.statement.id)).lines;
    await expect(matchLine(other.id, { kind: "SHOP_SETTLEMENT", id: s1.id }, accountant)).rejects.toThrow(/already matched to line 1 of BS-/);

    await expect(excludeLine(lines[1].id, "fee", accountant)).rejects.toThrow(/Say why/);
    await excludeLine(lines[1].id, "Bank charges (NEFT fee)", accountant);
    await unmatchLine(lines[0].id, accountant);
    await matchLine(other.id, { kind: "SHOP_SETTLEMENT", id: s1.id }, accountant);
    const after = await getStatement(first.statement.id);
    expect(after.check).toMatchObject({ matched: 0, excluded: 1, unmatched: 1 });
  });

  it("matches money received to a posted journal entry; a draft journal cannot be matched", async () => {
    const { accountant, ca } = await people();
    const je = await createJournalDraft(
      { entryDate: "2026-11-04", narration: "Cashfree settlement 04-Nov", lines: [{ accountCode: "1010", accountName: "HDFC", debitPaise: 2_500_000 }, { accountCode: "1200", accountName: "Gateway receivable", creditPaise: 2_500_000 }] },
      accountant,
    );
    const imported = await importStatement({ accountLabel: "HDFC ••1234", file: hdfcCsv([["04/11/26", "CASHFREE SETTLEMENT", "CF1", "", "25000.00", ""]]), filename: "a.csv" }, accountant);
    const [line] = (await getStatement(imported.statement.id)).lines;
    await expect(matchLine(line.id, { kind: "JOURNAL", id: je.id }, accountant)).rejects.toThrow(/not found|posted/i);
    const submitted = await submitJournal(je.id, accountant);
    await decideApproval({ requestId: submitted.approvalRequestId!, actor: ca, decision: "APPROVE" });
    // Re-running the automatic match suggests it (same amount, same day, no reference to confirm).
    await autoMatchStatement(imported.statement.id, accountant);
    expect((await getStatement(imported.statement.id)).lines[0].suggestion).toMatchObject({ kind: "JOURNAL", id: je.id });
    await matchLine(line.id, { kind: "JOURNAL", id: je.id }, accountant);
    expect((await getStatement(imported.statement.id)).lines[0].matchLabel).toMatch(/Cashfree settlement/);
  });

  it("lists payouts recorded as paid in the statement's dates that no bank line matches", async () => {
    const { accountant } = await people();
    const onBank = await paidSettlement(10_000, "UTRONBANK0001", "2026-11-03");
    const missing = await paidSettlement(20_000, "UTRMISSING0002", "2026-11-04");
    await paidSettlement(30_000, "UTROUTSIDE0003", "2026-12-15");
    const imported = await importStatement({ accountLabel: "HDFC ••1234", file: hdfcCsv([["03/11/26", "NEFT UTRONBANK0001", "", "100.00", "", ""], ["05/11/26", "x", "", "1.00", "", ""]]), filename: "a.csv" }, accountant);
    const items = await unmatchedBookItems(imported.statement.id);
    expect(items.map((i) => i.id)).toEqual([missing.id]);
    expect(items.map((i) => i.id)).not.toContain(onBank.id);
  });
});

describe("sign-off", () => {
  it("submits only when every line is resolved; the CA signs off; then nothing changes", async () => {
    const { accountant, ca } = await people();
    const s = await paidSettlement(150_000, "N312262345678901", "2026-11-03");
    const imported = await importStatement(
      { accountLabel: "HDFC ••1234", file: hdfcCsv([["03/11/26", "NEFT N312262345678901", "", "1500.00", "", ""], ["05/11/26", "SMS CHARGES", "", "17.70", "", ""]]), filename: "a.csv" },
      accountant,
    );
    const id = imported.statement.id;
    await expect(submitStatement(id, accountant)).rejects.toThrow(/1 line is still unmatched/);
    const lines = (await getStatement(id)).lines;
    await excludeLine(lines[1].id, "Bank SMS charges", accountant);

    const ca2 = await createUser({ role: "CA" });
    const submitted = await submitStatement(id, accountant);
    expect(submitted.status).toBe("SUBMITTED");
    await expect(unmatchLine(lines[0].id, accountant)).rejects.toThrow(/with the CA/);
    await expect(decideApproval({ requestId: submitted.approvalRequestId!, actor: accountant, decision: "APPROVE" })).rejects.toThrow(/Only a CA/);
    await expect(decideApproval({ requestId: submitted.approvalRequestId!, actor: { id: ca2.id, role: "CA" }, decision: "REJECT" })).rejects.toThrow(/Say why/);
    await decideApproval({ requestId: submitted.approvalRequestId!, actor: { id: ca2.id, role: "CA" }, decision: "REJECT", comment: "Attach the SMS charge advice" });
    const back = (await getStatement(id)).statement;
    expect(back).toMatchObject({ status: "OPEN", rejectionComment: "Attach the SMS charge advice" });

    const again = await submitStatement(id, accountant);
    await decideApproval({ requestId: again.approvalRequestId!, actor: ca, decision: "APPROVE" });
    const done = (await getStatement(id)).statement;
    expect(done).toMatchObject({ status: "RECONCILED", signedOffBy: ca.id });

    // Final: the database refuses changes to the statement or its lines, and deletion.
    await expect(db.update(finBankStatementLines).set({ note: "edited" }).where(eq(finBankStatementLines.statementId, id))).rejects.toBeTruthy();
    await expect(db.delete(finBankStatements).where(eq(finBankStatements.id, id))).rejects.toBeTruthy();
    await expect(deleteStatement(id, accountant)).rejects.toThrow(/reconciled and final/);
    // The matched settlement stays claimed.
    expect((await unmatchedBookItems(id)).map((i) => i.id)).not.toContain(s.id);
  });

  it("refuses to submit when opening + credits − debits does not reach the closing balance", async () => {
    const { accountant } = await people();
    const csv = ["Date,Narration,Debit,Credit,Balance", "Opening Balance,,,,1000.00", "05/11/2026,charges,10.00,,990.00", "06/11/2026,charges,10.00,,970.00"].join("\n");
    const imported = await importStatement({ accountLabel: "HDFC ••1234", file: Buffer.from(csv), filename: "a.csv" }, accountant);
    expect(imported.statement.warnings.join(" ")).toMatch(/does not follow/);
    for (const l of (await getStatement(imported.statement.id)).lines) await excludeLine(l.id, "Bank charges", accountant);
    await expect(submitStatement(imported.statement.id, accountant)).rejects.toThrow(/differs from the closing balance by ₹10.00/);
  });

  it("withdraw returns it to open; deleting an open statement releases its matches", async () => {
    const { accountant } = await people();
    const s = await paidSettlement(5_000, "UTRDEL000001", "2026-11-03");
    const imported = await importStatement({ accountLabel: "HDFC ••1234", file: hdfcCsv([["03/11/26", "NEFT UTRDEL000001", "", "50.00", "", ""]]), filename: "a.csv" }, accountant);
    const submitted = await submitStatement(imported.statement.id, accountant);
    expect(submitted.status).toBe("SUBMITTED");
    expect((await withdrawStatement(imported.statement.id, accountant)).status).toBe("OPEN");
    await deleteStatement(imported.statement.id, accountant);
    expect(await db.select().from(finBankStatementLines)).toHaveLength(0);
    const reimported = await importStatement({ accountLabel: "HDFC ••1234", file: hdfcCsv([["03/11/26", "NEFT UTRDEL000001", "", "50.00", "", ""]]), filename: "a.csv" }, accountant);
    expect(reimported.matched).toBe(1);
    expect((await getStatement(reimported.statement.id)).lines[0].matchId).toBe(s.id);
  });
});
