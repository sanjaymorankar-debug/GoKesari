/** docs/tax-register/BOOKS.md: the postings for paid payouts always balance and hit the right accounts. */
import { describe, expect, it } from "vitest";

import { balanced, commissionPosting, GK_ACCOUNTS, riderPosting, shopPayoutPosting, shopSettlementPosting } from "@/server/rbac-accounting/auto-post";

const sum = (lines: { debitPaise: number; creditPaise: number }[], k: "debitPaise" | "creditPaise") => lines.reduce((s, l) => s + l[k], 0);
const at = new Date("2026-11-24T06:00:00Z");

describe("shop payout", () => {
  it("credits each withholding to its account and the net to the bank", () => {
    const p = shopPayoutPosting({ id: "i1", shopName: "Dairy", amountPaise: 95_000, breakdown: { GOODS: 100_000, COMMISSION: -2_000, FEE_GST: -360, TCS: -500, TDS: -100, WALLET_TOPUP: -2_040 }, paidAt: at, utr: "UTR1" })!;
    expect(sum(p.lines, "debitPaise")).toBe(sum(p.lines, "creditPaise"));
    const credit = (code: string) => p.lines.find((l) => l.accountCode === code)?.creditPaise ?? 0;
    expect(credit(GK_ACCOUNTS.BANK.code)).toBe(95_000);
    expect(credit(GK_ACCOUNTS.TCS_PAYABLE.code)).toBe(500);
    expect(credit(GK_ACCOUNTS.TDS_194O_PAYABLE.code)).toBe(100);
    expect(credit(GK_ACCOUNTS.GST_OUTPUT_FEES.code)).toBe(360);
    expect(credit(GK_ACCOUNTS.COMMISSION_INCOME.code)).toBe(2_000);
    expect(p.lines.find((l) => l.accountCode === GK_ACCOUNTS.SHOP_PAYABLE.code)!.debitPaise).toBe(100_000);
    expect(p.entryDate).toBe("2026-11-24");
  });

  it("nothing for a zero payout", () => {
    expect(shopPayoutPosting({ id: "i2", shopName: "x", amountPaise: 0, breakdown: {}, paidAt: at, utr: "U" })).toBeNull();
  });
});

describe("other payouts", () => {
  it("weekly settlement, rider, dealer and referral postings balance", () => {
    const all = [
      shopSettlementPosting({ id: "s", shopName: "x", netPayablePaise: 9_800, commissionPaise: 200, paidAt: at, reference: null }),
      riderPosting({ sourceType: "rider_payouts", id: "r", riderName: "A", grossPaise: 4_000_000, tdsPaise: 40_000, feePaise: 0, netPaise: 3_960_000, paidAt: at, reference: "W" }),
      riderPosting({ sourceType: "rider_bank_transfers", id: "t", riderName: "A", grossPaise: 100_000, tdsPaise: 1_000, feePaise: 500, netPaise: 98_500, paidAt: at, reference: "U" }),
      commissionPosting({ sourceType: "dealer_payout_batches", id: "d", payee: "dealer", grossPaise: 50_000, tdsPaise: 1_000, paidAt: at, reference: "R" }),
      commissionPosting({ sourceType: "referral_commissions", id: "c", payee: "referrer", grossPaise: 30_000, tdsPaise: 600, paidAt: at, reference: null }),
    ];
    for (const p of all) {
      expect(p).not.toBeNull();
      expect(sum(p!.lines, "debitPaise")).toBe(sum(p!.lines, "creditPaise"));
      expect(p!.lines.every((l) => l.debitPaise > 0 || l.creditPaise > 0)).toBe(true);
    }
    expect(all[1]!.lines.find((l) => l.accountCode === GK_ACCOUNTS.TDS_194C_PAYABLE.code)!.creditPaise).toBe(40_000);
    expect(all[4]!.lines.find((l) => l.accountCode === GK_ACCOUNTS.TDS_194H_PAYABLE.code)!.creditPaise).toBe(600);
  });

  it("an unbalanced posting is never queued", () => {
    expect(balanced({ sourceType: "x", sourceId: "y", entryDate: "2026-11-24", narration: "n", lines: [{ accountCode: "1", accountName: "a", debitPaise: 10, creditPaise: 0 }, { accountCode: "2", accountName: "b", debitPaise: 0, creditPaise: 9 }] })).toBeNull();
  });
});
