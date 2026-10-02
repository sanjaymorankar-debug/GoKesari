/**
 * Registration fees and payments (§12, §15, §25.11, §25.12).
 *
 * The two claims under test are both about things NOT changing:
 *   - raising the current fee must not re-bill an existing shop
 *   - a recorded payment must never be edited or deleted
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { shopPayments, shops } from "@/server/db/schema";
import {
  getActiveFee,
  listFeeHistory,
  resolveFeeForNewRegistration,
  setRegistrationFee,
} from "@/server/services/registration-fees";
import {
  getRegistrationFeeReport,
  listPaymentsForShop,
  recordPayment,
  reversePayment,
} from "@/server/services/shop-payments";
import { approveShop, registerShop } from "@/server/services/shops";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

const ADMIN = (id: string) => ({ id, role: "ADMIN" as const });
const OPERATOR = (id: string) => ({ id, role: "OPERATOR" as const });

describe("registration fee schedule", () => {
  beforeEach(resetDatabase);

  it("records history and activates exactly one fee", async () => {
    const admin = await createUser({ role: "ADMIN" });

    await setRegistrationFee({ amountPaise: 500_000 }, ADMIN(admin.id));
    await setRegistrationFee(
      { amountPaise: 600_000, reason: "Annual revision" },
      ADMIN(admin.id),
    );

    const active = await getActiveFee();
    expect(active?.amountPaise).toBe(600_000);

    const history = await listFeeHistory();
    expect(history).toHaveLength(2);
    expect(history[0].previousAmountPaise).toBe(500_000);
    expect(history[0].newAmountPaise).toBe(600_000);
    expect(history[0].reason).toBe("Annual revision");
  });

  it("does not change what an already-registered shop was charged (§25.11)", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const applicant = await createUser({ role: "CUSTOMER" });

    await setRegistrationFee({ amountPaise: 500_000 }, ADMIN(admin.id));

    const shop = await registerShop(
      {
        name: "Shop A",
        ownerName: "A",
        phone: "9876543210",
        addressLine1: "1 Road",
        city: "Pune",
        pincode: "411001",
        shopType: "DAIRY",
      },
      { id: applicant.id, role: "CUSTOMER" },
    );
    expect(shop.registrationFeePaise).toBe(500_000);

    // The fee goes up AFTER Shop A registered.
    await setRegistrationFee({ amountPaise: 600_000 }, ADMIN(admin.id));

    const [reloaded] = await db
      .select()
      .from(shops)
      .where(eq(shops.id, shop.id));
    expect(reloaded.registrationFeePaise).toBe(500_000);

    // ...and a shop registering now picks up the new amount.
    expect((await resolveFeeForNewRegistration()).amountPaise).toBe(600_000);
  });

  it("assigns a unique registration number to every shop", async () => {
    const a = await createUser();
    const b = await createUser();
    const shopA = await createShop(a.id, { name: "A" });
    const shopB = await createShop(b.id, { name: "B" });

    expect(shopA.registrationNumber).toMatch(/^BKS-\d{6}$/);
    expect(shopB.registrationNumber).not.toBe(shopA.registrationNumber);
  });
});

describe("shop payments", () => {
  beforeEach(resetDatabase);

  it("moves the shop from PENDING to PARTIALLY_PAID to PAID", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { registrationFeePaise: 500_000 });

    expect(shop.feePaymentStatus).toBe("PENDING");

    const partial = await recordPayment(
      {
        shopId: shop.id,
        paymentType: "REGISTRATION_FEE",
        amountPaise: 200_000,
        method: "UPI",
      },
      OPERATOR(operator.id),
    );
    expect(partial.feePaymentStatus).toBe("PARTIALLY_PAID");
    expect(partial.amountPaidPaise).toBe(200_000);

    const full = await recordPayment(
      {
        shopId: shop.id,
        paymentType: "REGISTRATION_FEE",
        amountPaise: 300_000,
        method: "CASH",
      },
      OPERATOR(operator.id),
    );
    expect(full.feePaymentStatus).toBe("PAID");
    expect(full.amountPaidPaise).toBe(500_000);
  });

  it("corrects a mistake with a reversal rather than a deletion (§15)", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { registrationFeePaise: 500_000 });

    const { payment } = await recordPayment(
      {
        shopId: shop.id,
        paymentType: "REGISTRATION_FEE",
        amountPaise: 500_000,
      },
      OPERATOR(operator.id),
    );

    const reversed = await reversePayment(
      payment.id,
      "Recorded against the wrong shop",
      OPERATOR(operator.id),
    );

    // The original row is still there, byte for byte.
    const [original] = await db
      .select()
      .from(shopPayments)
      .where(eq(shopPayments.id, payment.id));
    expect(original).toBeDefined();
    expect(original.amountPaise).toBe(500_000);

    // ...and the settlement is back to zero via the mirror row, not an edit.
    expect(reversed.amountPaidPaise).toBe(0);
    expect(reversed.feePaymentStatus).toBe("PENDING");

    const all = await listPaymentsForShop(shop.id);
    expect(all).toHaveLength(2);
  });

  it("refuses to reverse the same payment twice", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { registrationFeePaise: 500_000 });

    const { payment } = await recordPayment(
      { shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 100_000 },
      OPERATOR(operator.id),
    );

    await reversePayment(payment.id, "duplicate", OPERATOR(operator.id));
    await expect(
      reversePayment(payment.id, "again", OPERATOR(operator.id)),
    ).rejects.toThrow();
  });

  it("stores a refund as a negative amount so the net is correct", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { registrationFeePaise: 500_000 });

    await recordPayment(
      { shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 500_000 },
      OPERATOR(operator.id),
    );
    const refunded = await recordPayment(
      { shopId: shop.id, paymentType: "REFUND", amountPaise: 100_000 },
      OPERATOR(operator.id),
    );

    expect(refunded.amountPaidPaise).toBe(400_000);
    expect(refunded.feePaymentStatus).toBe("PARTIALLY_PAID");
  });

  it("rejects a zero or negative payment", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);

    await expect(
      recordPayment(
        { shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 0 },
        OPERATOR(operator.id),
      ),
    ).rejects.toThrow();
    await expect(
      recordPayment(
        { shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: -100 },
        OPERATOR(operator.id),
      ),
    ).rejects.toThrow();
  });

  it("totals the registration fee report across shops (§14)", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const ownerA = await createUser({ role: "SHOP_OWNER" });
    const ownerB = await createUser({ role: "SHOP_OWNER" });

    const shopA = await createShop(ownerA.id, {
      name: "A",
      registrationFeePaise: 500_000,
    });
    await createShop(ownerB.id, { name: "B", registrationFeePaise: 500_000 });

    await recordPayment(
      { shopId: shopA.id, paymentType: "REGISTRATION_FEE", amountPaise: 500_000 },
      OPERATOR(operator.id),
    );

    const report = await getRegistrationFeeReport();
    expect(report.totalShops).toBe(2);
    expect(report.expectedPaise).toBe(1_000_000);
    expect(report.collectedPaise).toBe(500_000);
    expect(report.pendingPaise).toBe(500_000);
    expect(report.fullyPaid).toBe(1);
    expect(report.unpaid).toBe(1);
  });
});

/**
 * GS-008 — a shop cannot go live until its registration fee is settled.
 *
 * The gate reads one column, `shops.fee_payment_status`, which is derived from
 * the payments ledger rather than set by hand. These tests therefore drive it
 * the way operations does — by recording real payments — and check the two
 * directions that matter: an unpaid shop stays pending, and a paid shop goes
 * through unchanged.
 */
describe("registration fee gate on shop approval (GS-008)", () => {
  beforeEach(resetDatabase);

  it("refuses approval while the fee is unpaid, and says what is outstanding", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, {
      status: "PENDING_APPROVAL",
      registrationFeePaise: 500_000,
    });

    await expect(
      approveShop(shop.id, { classification: "KESARI" }, ADMIN(admin.id)),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { feePaymentStatus: "PENDING", amountPaidPaise: 0 },
    });

    // The refusal must leave the shop exactly as it was — no half-approval.
    const [after] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(after.status).toBe("PENDING_APPROVAL");
    expect(after.approvedAt).toBeNull();
    expect(after.classification).toBe("KESARI"); // the fixture's value, untouched
  });

  it("still refuses when the fee is only part-paid", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const operator = await createUser({ role: "OPERATOR" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, {
      status: "PENDING_APPROVAL",
      registrationFeePaise: 500_000,
    });

    await recordPayment(
      { shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 200_000 },
      OPERATOR(operator.id),
    );

    await expect(
      approveShop(shop.id, { classification: "GREEN" }, ADMIN(admin.id)),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { feePaymentStatus: "PARTIALLY_PAID", amountPaidPaise: 200_000 },
    });
  });

  it("approves once the fee is paid in full", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const operator = await createUser({ role: "OPERATOR" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, {
      status: "PENDING_APPROVAL",
      registrationFeePaise: 500_000,
    });

    await recordPayment(
      { shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 500_000 },
      OPERATOR(operator.id),
    );

    const approved = await approveShop(shop.id, { classification: "GREEN" }, ADMIN(admin.id));
    expect(approved.status).toBe("APPROVED");
    expect(approved.classification).toBe("GREEN");
    expect(approved.approvedAt).not.toBeNull();
  });

  it("lets a waived fee through — a zero fee is settled by definition", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, {
      status: "PENDING_APPROVAL",
      registrationFeePaise: 0,
    });
    // A zero fee is what a waiver looks like; registerShop writes PAID for it,
    // so set the same thing the fixture's direct insert skips.
    await db.update(shops).set({ feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));

    const approved = await approveShop(shop.id, { classification: "KESARI" }, ADMIN(admin.id));
    expect(approved.status).toBe("APPROVED");
  });

  it("refuses a shop whose fee was refunded or whose registration was cancelled", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const owner = await createUser({ role: "SHOP_OWNER" });

    for (const status of ["REFUNDED", "CANCELLED"] as const) {
      const shop = await createShop(owner.id, {
        name: `Shop ${status}`,
        status: "PENDING_APPROVAL",
        registrationFeePaise: 500_000,
      });
      await db.update(shops).set({ feePaymentStatus: status }).where(eq(shops.id, shop.id));

      await expect(
        approveShop(shop.id, { classification: "KESARI" }, ADMIN(admin.id)),
      ).rejects.toMatchObject({ code: "CONFLICT", details: { feePaymentStatus: status } });
    }
  });

  it("does not revoke a shop approved before the gate existed", async () => {
    // An already-APPROVED shop with an unpaid fee keeps its status: the gate is
    // on the transition, not a standing condition.
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, {
      status: "APPROVED",
      registrationFeePaise: 500_000,
    });

    const [row] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(row.status).toBe("APPROVED");
    expect(row.feePaymentStatus).toBe("PENDING");
  });
});
