/**
 * Voucher / promotional-credit system (wallet & voucher brief, Part B).
 *
 * Covers the numbered test scenarios that are meaningful at the service
 * layer: 10 (create), 11 (edit), 12 (activate), 13 (expire), 14/15 (apply
 * 10%/20%), 16 (minimum top-up), 17 (maximum bonus), 18/19 (usage limits),
 * 20 (budget exhaustion), 21/22 (Excel upload), 23 (duplicate codes), 24
 * (concurrent redemption), 29 (unauthorized create), 30 (client-supplied
 * bonus manipulation).
 */
import ExcelJS from "exceljs";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { PERMISSIONS, can } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { voucherRedemptions, vouchers } from "@/server/db/schema";
import {
  createVoucher,
  previewVoucher,
  redeemVoucher,
  resolveEffectiveStatus,
  setVoucherStatus,
  updateVoucher,
  validateVoucherUpload,
  applyVoucherUpload,
} from "@/server/services/vouchers";
import {
  createPayment,
  createUserWithWallet,
  createVoucher as createVoucherFixture,
  resetDatabase,
} from "../helpers/fixtures";

const ADMIN = (id: string) => ({ id, role: "ADMIN" as const });

/**
 * A live window anchored to today: since TC-FLD-114 a new voucher whose end
 * date has passed is refused, so fixed September 2026 dates aged out.
 */
const TODAY = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10); // today in IST (APP_TIMEZONE)
const IN_30_DAYS = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

/**
 * voucher_redemptions.payment_id is a real FK to payments.id, so every
 * redemption in these tests needs a genuine payment row behind it — this
 * wraps that plumbing so each test reads as "redeem X for Y", not a payments
 * fixture followed by a redemption call.
 */
async function redeemFor(
  code: string,
  actor: { id: string },
  walletId: string,
  topupAmountPaise: number,
) {
  const payment = await createPayment(actor.id, { amountPaise: topupAmountPaise });
  return redeemVoucher({
    code,
    userId: actor.id,
    walletId,
    topupAmountPaise,
    paymentId: payment.id,
  });
}

async function buildVoucherWorkbook(rows: (string | number)[][]): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["Voucher Name", "Voucher Code", "Bonus %", "Min Top-Up", "Max Bonus", "Start Date", "End Date"]);
  for (const row of rows) sheet.addRow(row);
  return workbook.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}

describe("voucher permissions", () => {
  it("reserves voucher creation to ADMIN, not the customer or shop owner (TEST 29)", () => {
    expect(can("CUSTOMER", PERMISSIONS.VOUCHER_MANAGE)).toBe(false);
    expect(can("SHOP_OWNER", PERMISSIONS.VOUCHER_MANAGE)).toBe(false);
    expect(can("OPERATOR", PERMISSIONS.VOUCHER_MANAGE)).toBe(false);
    expect(can("ADMIN", PERMISSIONS.VOUCHER_MANAGE)).toBe(true);
  });

  it("lets an operator upload voucher lists without granting VOUCHER_MANAGE", () => {
    expect(can("OPERATOR", PERMISSIONS.VOUCHER_UPLOAD)).toBe(true);
    expect(can("OPERATOR", PERMISSIONS.VOUCHER_MANAGE)).toBe(false);
  });
});

describe("voucher creation & validation (TEST 10, 16, 17)", () => {
  beforeEach(resetDatabase);

  it("creates a voucher with the exact §12 example fields", async () => {
    const admin = await createUserWithWallet({ role: "ADMIN" });
    const voucher = await createVoucher(
      {
        name: "Festival 10% Bonus",
        code: "FEST10",
        bonusPercent: 10,
        minimumTopupPaise: 50_000,
        maximumBonusPaise: 100_000,
        startDate: TODAY,
        endDate: IN_30_DAYS,
      },
      ADMIN(admin.user.id),
    );
    expect(voucher.code).toBe("FEST10");
    expect(voucher.status).toBe("ACTIVE");
  });

  it("rejects a negative or zero bonus percentage", async () => {
    const admin = await createUserWithWallet({ role: "ADMIN" });
    await expect(
      createVoucher(
        { name: "Bad Voucher", code: "BAD1", bonusPercent: -10, startDate: "2026-09-01", endDate: "2026-09-30" },
        ADMIN(admin.user.id),
      ),
    ).rejects.toThrow();
    await expect(
      createVoucher(
        { name: "Bad Voucher", code: "BAD2", bonusPercent: 0, startDate: "2026-09-01", endDate: "2026-09-30" },
        ADMIN(admin.user.id),
      ),
    ).rejects.toThrow();
  });

  it("TC-FLD-114: refuses a code with spaces or symbols, naming the code field", async () => {
    const admin = await createUserWithWallet({ role: "ADMIN" });
    const start = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    for (const code of ["QA CODE 1", "QA<>!@#", "AB"]) {
      await expect(
        createVoucher({ name: "Bad Code", code, bonusPercent: 10, startDate: start, endDate: end }, ADMIN(admin.user.id)),
        code,
      ).rejects.toMatchObject({ details: { fields: { code: expect.stringMatching(/letters, digits/) } } });
    }
    const ok = await createVoucher({ name: "Good Code", code: "diwali-25", bonusPercent: 10, startDate: start, endDate: end }, ADMIN(admin.user.id));
    expect(ok.code).toBe("DIWALI-25");
  });

  it("rejects an end date before the start date", async () => {
    const admin = await createUserWithWallet({ role: "ADMIN" });
    await expect(
      createVoucher(
        { name: "Bad Dates", code: "BADDATE", bonusPercent: 10, startDate: "2026-09-30", endDate: "2026-09-01" },
        ADMIN(admin.user.id),
      ),
    ).rejects.toThrow();
  });

  it("rejects a duplicate voucher code", async () => {
    const admin = await createUserWithWallet({ role: "ADMIN" });
    await createVoucher(
      { name: "First", code: "DUPE", bonusPercent: 10, startDate: TODAY, endDate: IN_30_DAYS },
      ADMIN(admin.user.id),
    );
    await expect(
      createVoucher(
        { name: "Second", code: "DUPE", bonusPercent: 5, startDate: TODAY, endDate: IN_30_DAYS },
        ADMIN(admin.user.id),
      ),
    ).rejects.toThrow();
  });

  it("edits a voucher (TEST 11)", async () => {
    const admin = await createUserWithWallet({ role: "ADMIN" });
    const voucher = await createVoucherFixture({ bonusPercent: 10 });
    const updated = await updateVoucher(voucher.id, { bonusPercent: 15 }, ADMIN(admin.user.id));
    expect(updated.bonusPercent).toBe(15);
  });

  it("activates and pauses a voucher (TEST 12)", async () => {
    const admin = await createUserWithWallet({ role: "ADMIN" });
    const voucher = await createVoucherFixture({ status: "PAUSED" });
    expect(resolveEffectiveStatus(voucher)).toBe("PAUSED");

    const activated = await setVoucherStatus(voucher.id, "ACTIVE", ADMIN(admin.user.id));
    expect(resolveEffectiveStatus(activated)).toBe("ACTIVE");
  });
});

describe("voucher expiry (TEST 13)", () => {
  beforeEach(resetDatabase);

  it("marks a voucher EXPIRED the day after its end date without deleting it", async () => {
    const voucher = await createVoucherFixture({ endDate: "2026-09-30" });
    expect(resolveEffectiveStatus(voucher, "2026-09-30")).toBe("ACTIVE");
    expect(resolveEffectiveStatus(voucher, "2026-10-01")).toBe("EXPIRED");

    const [stillThere] = await db.select().from(vouchers).where(eq(vouchers.id, voucher.id));
    expect(stillThere).toBeDefined();
  });

  it("refuses to redeem an expired voucher", async () => {
    const { user, wallet } = await createUserWithWallet({ balancePaise: 0 });
    const voucher = await createVoucherFixture({ startDate: "2020-01-01", endDate: "2020-01-31" });

    await expect(redeemFor(voucher.code!, user, wallet.id, 100_000)).rejects.toThrow(/expired/i);
  });
});

describe("applying a voucher — the §38 end-to-end example", () => {
  beforeEach(resetDatabase);

  it("applies WELCOME10: ₹1,000 top-up + 10% bonus capped at ₹500 (TEST 14)", async () => {
    const { user, wallet } = await createUserWithWallet({ balancePaise: 0 });
    await createVoucherFixture({
      code: "WELCOME10",
      bonusPercent: 10,
      minimumTopupPaise: 50_000,
      maximumBonusPaise: 50_000,
    });

    const preview = await previewVoucher("WELCOME10", 100_000, user.id);
    expect(preview.bonusAmountPaise).toBe(10_000); // ₹100
    expect(preview.totalCreditPaise).toBe(110_000); // ₹1,100

    const redemption = await redeemFor("WELCOME10", user, wallet.id, 100_000);
    expect(redemption.bonusAmountPaise).toBe(10_000);
    expect(redemption.status).toBe("APPLIED");
  });

  it("applies a 20% voucher correctly (TEST 15)", async () => {
    const { user, wallet } = await createUserWithWallet({ balancePaise: 0 });
    await createVoucherFixture({ code: "TWENTY", bonusPercent: 20 });

    const redemption = await redeemFor("TWENTY", user, wallet.id, 500_000);
    expect(redemption.bonusAmountPaise).toBe(100_000); // ₹1,000
  });

  it("caps the bonus at the maximum even when the percentage would exceed it (§14)", async () => {
    const { user, wallet } = await createUserWithWallet({ balancePaise: 0 });
    await createVoucherFixture({ code: "CAPPED", bonusPercent: 10, maximumBonusPaise: 50_000 });

    // ₹10,000 → 10% would be ₹1,000, capped at ₹500.
    const redemption = await redeemFor("CAPPED", user, wallet.id, 1_000_000);
    expect(redemption.bonusAmountPaise).toBe(50_000);
  });

  it("rejects a top-up below the minimum (TEST 16)", async () => {
    const { user, wallet } = await createUserWithWallet({ balancePaise: 0 });
    await createVoucherFixture({ code: "MINTEST", minimumTopupPaise: 100_000 });

    await expect(redeemFor("MINTEST", user, wallet.id, 50_000)).rejects.toThrow(/minimum top-up/i);
  });

  it("never trusts a client-supplied bonus figure — always recomputes server-side (TEST 30)", async () => {
    const { user, wallet } = await createUserWithWallet({ balancePaise: 0 });
    await createVoucherFixture({ code: "SERVERCALC", bonusPercent: 10 });

    // redeemVoucher's input has no bonus field at all — there is no channel
    // through which a caller could supply one; the type system itself makes
    // "bonus = 500" unrepresentable, which is the point.
    const redemption = await redeemFor("SERVERCALC", user, wallet.id, 100_000);
    expect(redemption.bonusAmountPaise).toBe(10_000); // exactly 10%, nothing else
  });
});

describe("usage limits (TEST 18, 19)", () => {
  beforeEach(resetDatabase);

  it("stops redemption once the total usage limit is reached", async () => {
    await createVoucherFixture({ code: "LIMIT1", usageLimit: 1, perCustomerLimit: 5 });
    const a = await createUserWithWallet({ balancePaise: 0 });
    const b = await createUserWithWallet({ balancePaise: 0 });

    await redeemFor("LIMIT1", a.user, a.wallet.id, 100_000);

    await expect(redeemFor("LIMIT1", b.user, b.wallet.id, 100_000)).rejects.toThrow();
  });

  it("stops a customer reusing a voucher past their per-customer limit", async () => {
    await createVoucherFixture({ code: "ONEUSE", perCustomerLimit: 1 });
    const { user, wallet } = await createUserWithWallet({ balancePaise: 0 });

    await redeemFor("ONEUSE", user, wallet.id, 100_000);

    await expect(redeemFor("ONEUSE", user, wallet.id, 100_000)).rejects.toThrow(/already used/i);
  });
});

describe("budget exhaustion (TEST 20)", () => {
  beforeEach(resetDatabase);

  it("refuses a redemption that would push spend over the total budget", async () => {
    await createVoucherFixture({ code: "BUDGETED", bonusPercent: 10, totalBudgetPaise: 15_000 });
    const a = await createUserWithWallet({ balancePaise: 0 });
    const b = await createUserWithWallet({ balancePaise: 0 });

    // First redemption: ₹1,000 topup → ₹100 bonus. Budget now 100/150.
    await redeemFor("BUDGETED", a.user, a.wallet.id, 100_000);

    // Second: another ₹100 bonus would push budget to 200 > 150 — rejected.
    await expect(redeemFor("BUDGETED", b.user, b.wallet.id, 100_000)).rejects.toThrow();

    const [voucher] = await db.select().from(vouchers).where(eq(vouchers.code, "BUDGETED"));
    expect(voucher.budgetUsedPaise).toBe(10_000); // only the first redemption counted
  });
});

describe("concurrent redemption (TEST 24)", () => {
  beforeEach(resetDatabase);

  it("lets only ONE of two simultaneous redemptions succeed against a 1-use limit", async () => {
    await createVoucherFixture({ code: "RACE1", usageLimit: 1 });
    const a = await createUserWithWallet({ balancePaise: 0 });
    const b = await createUserWithWallet({ balancePaise: 0 });

    const results = await Promise.allSettled([
      redeemFor("RACE1", a.user, a.wallet.id, 100_000),
      redeemFor("RACE1", b.user, b.wallet.id, 100_000),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const applied = await db
      .select()
      .from(voucherRedemptions)
      .where(and(eq(voucherRedemptions.status, "APPLIED")));
    expect(applied).toHaveLength(1);
  });

  it("redeeming with the same payment id twice returns the same redemption, not a second one", async () => {
    await createVoucherFixture({ code: "IDEMPOTENT" });
    const { user, wallet } = await createUserWithWallet({ balancePaise: 0 });
    const payment = await createPayment(user.id, { amountPaise: 100_000 });
    const paymentId = payment.id;

    const first = await redeemVoucher({
      code: "IDEMPOTENT",
      userId: user.id,
      walletId: wallet.id,
      topupAmountPaise: 100_000,
      paymentId,
    });
    const second = await redeemVoucher({
      code: "IDEMPOTENT",
      userId: user.id,
      walletId: wallet.id,
      topupAmountPaise: 100_000,
      paymentId,
    });
    expect(second.id).toBe(first.id);

    const [voucher] = await db.select().from(vouchers).where(eq(vouchers.code, "IDEMPOTENT"));
    expect(voucher.redemptionCount).toBe(1);
  });
});

describe("voucher Excel upload (TEST 21, 22, 23)", () => {
  beforeEach(resetDatabase);

  it("uploads a valid voucher list matching the §16 example (TEST 21)", async () => {
    const admin = await createUserWithWallet({ role: "ADMIN" });
    const buffer = await buildVoucherWorkbook([
      ["Diwali 10%", "DIWALI10", 10, 500, 500, "2026-09-01", "2026-09-30"],
      ["Festive 15%", "FESTIVE15", 15, 1000, 1000, "2026-09-01", "2026-09-15"],
    ]);

    const preview = await validateVoucherUpload(
      { fileName: "vouchers.xlsx", buffer },
      ADMIN(admin.user.id),
    );
    expect(preview.counts.valid).toBe(2);

    const result = await applyVoucherUpload(preview.uploadId, ADMIN(admin.user.id));
    expect(result.created).toBe(2);

    const [voucher] = await db.select().from(vouchers).where(eq(vouchers.code, "DIWALI10"));
    expect(voucher.bonusPercent).toBe(10);
    expect(voucher.minimumTopupPaise).toBe(50_000);
  });

  it("rejects invalid rows without corrupting the rest of the upload (TEST 22)", async () => {
    const admin = await createUserWithWallet({ role: "ADMIN" });
    const buffer = await buildVoucherWorkbook([
      ["Good Voucher", "GOOD1", 10, 500, 500, "2026-09-01", "2026-09-30"],
      ["Bad Percent", "BADPCT", -5, 500, 500, "2026-09-01", "2026-09-30"],
      ["Bad Dates", "BADDATE", 10, 500, 500, "2026-09-30", "2026-09-01"],
    ]);

    const preview = await validateVoucherUpload(
      { fileName: "vouchers.xlsx", buffer },
      ADMIN(admin.user.id),
    );
    expect(preview.rows[0].status).toBe("VALID");
    expect(preview.rows[1].status).toBe("INVALID");
    expect(preview.rows[2].status).toBe("INVALID");
    expect(preview.counts.valid).toBe(1);

    await applyVoucherUpload(preview.uploadId, ADMIN(admin.user.id));
    const all = await db.select().from(vouchers);
    expect(all).toHaveLength(1);
    expect(all[0].code).toBe("GOOD1");
  });

  it("flags duplicate voucher codes within the same file (TEST 23)", async () => {
    const admin = await createUserWithWallet({ role: "ADMIN" });
    const buffer = await buildVoucherWorkbook([
      ["First", "SAME1", 10, 500, 500, "2026-09-01", "2026-09-30"],
      ["Second", "SAME1", 15, 500, 500, "2026-09-01", "2026-09-30"],
    ]);

    const preview = await validateVoucherUpload(
      { fileName: "vouchers.xlsx", buffer },
      ADMIN(admin.user.id),
    );
    expect(preview.rows[0].status).toBe("VALID");
    expect(preview.rows[1].status).toBe("DUPLICATE_IN_FILE");
  });

  it("flags a code that already exists as a voucher", async () => {
    const admin = await createUserWithWallet({ role: "ADMIN" });
    await createVoucherFixture({ code: "EXISTING1" });

    const buffer = await buildVoucherWorkbook([
      ["Existing", "EXISTING1", 10, 500, 500, "2026-09-01", "2026-09-30"],
    ]);
    const preview = await validateVoucherUpload(
      { fileName: "vouchers.xlsx", buffer },
      ADMIN(admin.user.id),
    );
    expect(preview.rows[0].status).toBe("DUPLICATE_EXISTING");
  });
});
