/**
 * Shop membership renewal (modules 8 + 9, docs/shop-membership-renewal-2026-11). Real PostgreSQL:
 *   - a fee extends the membership only once fully paid (partial instalments wait);
 *   - a renewal extends from the current expiry;
 *   - a refund or reversal of a renewal takes the period back;
 *   - online renewal through the sandbox gateway: idempotent capture, one charge per period,
 *     a second payment for the same period recorded but not extended;
 *   - OFF switches: no checkout, no reminders, nobody closed;
 *   - exemptions (per shop, by shop type) keep a lapsed shop online.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { notifications, paymentIntents, shopMembershipPeriods, shopPayments, shops } from "@/server/db/schema";
import { toIntentRef } from "@/server/payments/intent-store";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { resetRateLimits } from "@/server/api/rate-limit";
import { withWalletGate } from "@/server/services/serviceability";
import {
  onShopMembershipRenewalCaptured,
  runMembershipRenewalReminders,
  setMembershipExemption,
  startMembershipRenewalCheckout,
} from "@/server/services/shop-membership-renewal";
import { recordPayment, reversePayment } from "@/server/services/shop-payments";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

const DAY = 86_400_000;
const FEE = 100_000;

let admin: { id: string; role: "ADMIN" };

beforeEach(async () => {
  resetRateLimits();
  clearRuleCache();
  await resetDatabase();
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
});

async function shopRow(id: string) {
  const [row] = await db.select().from(shops).where(eq(shops.id, id));
  return row;
}

async function periods(shopId: string) {
  return db.select().from(shopMembershipPeriods).where(eq(shopMembershipPeriods.shopId, shopId));
}

/** A live shop whose registration fee is paid and whose membership ends `days` from now. */
async function liveShop(days: number, extra: Parameters<typeof createShop>[1] = {}) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { status: "APPROVED", registrationFeePaise: FEE, ...extra });
  await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: FEE }, admin);
  const until = new Date(Date.now() + days * DAY);
  await db.update(shops).set({ membershipValidUntil: until }).where(eq(shops.id, shop.id));
  // Keep the recorded period consistent with the end date the test sets.
  await db.update(shopMembershipPeriods).set({ periodEnd: until, periodStart: new Date(until.getTime() - 365 * DAY) }).where(eq(shopMembershipPeriods.shopId, shop.id));
  return { owner, shop: await shopRow(shop.id), until };
}

describe("partial instalments", () => {
  it("the registration fee starts the membership only once it is fully paid", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", registrationFeePaise: FEE });
    await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 40_000 }, admin);
    expect((await shopRow(shop.id)).membershipValidUntil).toBeNull();
    expect(await periods(shop.id)).toHaveLength(0);

    const paidAt = new Date("2026-11-20T10:00:00Z");
    const done = await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 60_000, paidAt }, admin);
    expect(done.membership?.periodEnd?.toISOString()).toBe("2027-11-20T10:00:00.000Z");
    expect((await shopRow(shop.id)).membershipValidUntil?.toISOString()).toBe("2027-11-20T10:00:00.000Z");
    const [p] = await periods(shop.id);
    expect(p).toMatchObject({ kind: "REGISTRATION", feePaise: FEE, shopPaymentId: done.payment.id });
  });

  it("a renewal paid in two parts extends once, from the current expiry, when the second part arrives", async () => {
    const { shop, until } = await liveShop(10);
    await recordPayment({ shopId: shop.id, paymentType: "RENEWAL", amountPaise: 30_000 }, admin);
    expect((await shopRow(shop.id)).membershipValidUntil?.getTime()).toBe(until.getTime());
    await recordPayment({ shopId: shop.id, paymentType: "RENEWAL", amountPaise: 70_000 }, admin);
    const after = (await shopRow(shop.id)).membershipValidUntil!;
    // From the current end (still 10 days away), not from today.
    expect(after.getTime() - until.getTime()).toBeGreaterThan(360 * DAY);
    expect(after.getTime() - until.getTime()).toBeLessThan(370 * DAY);
    expect((await periods(shop.id)).filter((p) => p.kind === "RENEWAL")).toHaveLength(1);
  });
});

describe("refund and reversal roll the period back", () => {
  it("a refund of the renewal takes its year off and voids the period", async () => {
    const { shop, until } = await liveShop(5);
    await recordPayment({ shopId: shop.id, paymentType: "RENEWAL", amountPaise: FEE }, admin);
    expect((await shopRow(shop.id)).membershipValidUntil!.getTime()).toBeGreaterThan(until.getTime());

    await recordPayment({ shopId: shop.id, paymentType: "REFUND", amountPaise: FEE, note: "renewal refunded" }, admin);
    expect((await shopRow(shop.id)).membershipValidUntil?.getTime()).toBe(until.getTime());
    const renewal = (await periods(shop.id)).find((p) => p.kind === "RENEWAL");
    expect(renewal?.voidedAt).not.toBeNull();
    // The registration period is still paid for and stays.
    expect((await periods(shop.id)).find((p) => p.kind === "REGISTRATION")?.voidedAt).toBeNull();
  });

  it("a partial refund that leaves the renewal unpaid takes it back too; a reversal does the same", async () => {
    const { shop, until } = await liveShop(5);
    const paid = await recordPayment({ shopId: shop.id, paymentType: "RENEWAL", amountPaise: FEE }, admin);
    await reversePayment(paid.payment.id, "recorded twice", admin);
    expect((await shopRow(shop.id)).membershipValidUntil?.getTime()).toBe(until.getTime());
    expect((await periods(shop.id)).filter((p) => p.kind === "RENEWAL" && p.voidedAt === null)).toHaveLength(0);

    await recordPayment({ shopId: shop.id, paymentType: "RENEWAL", amountPaise: FEE }, admin);
    await recordPayment({ shopId: shop.id, paymentType: "REFUND", amountPaise: 1_000 }, admin);
    expect((await shopRow(shop.id)).membershipValidUntil?.getTime()).toBe(until.getTime());
  });
});

describe("online renewal (sandbox gateway)", () => {
  async function checkoutOn() {
    await setRule("shopMembership", { renewalCheckoutEnabled: true }, admin);
    clearRuleCache();
  }

  it("OFF by default: no checkout starts", async () => {
    const { owner, shop } = await liveShop(10);
    await expect(startMembershipRenewalCheckout(shop.id, owner)).rejects.toMatchObject({ status: 409 });
  });

  it("pays once per period, records RENEWAL ONLINE, extends from the expiry; a replayed capture changes nothing", async () => {
    await checkoutOn();
    const { owner, shop, until } = await liveShop(10);
    const first = await startMembershipRenewalCheckout(shop.id, owner);
    expect(first.amountPaise).toBe(FEE); // registered before the breakdown: its registration total
    const again = await startMembershipRenewalCheckout(shop.id, owner);
    expect(again.intentId).toBe(first.intentId);

    await simulateSandboxCheckout({ ref: first.intentId, viewerId: owner.id, outcome: "SUCCESS" });
    const row = await shopRow(shop.id);
    expect(row.membershipValidUntil!.getTime() - until.getTime()).toBeGreaterThan(360 * DAY);
    const ledger = await db.select().from(shopPayments).where(and(eq(shopPayments.shopId, shop.id), eq(shopPayments.paymentType, "RENEWAL")));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ method: "ONLINE", amountPaise: FEE });

    const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, first.intentId));
    await db.transaction((tx) => onShopMembershipRenewalCaptured(toIntentRef(intent), tx, () => undefined));
    expect(await db.select().from(shopPayments).where(and(eq(shopPayments.shopId, shop.id), eq(shopPayments.paymentType, "RENEWAL")))).toHaveLength(1);
    expect((await shopRow(shop.id)).membershipValidUntil?.getTime()).toBe(row.membershipValidUntil?.getTime());

    // Renewed: the next renewal is a year away, so Renew now is closed.
    await expect(startMembershipRenewalCheckout(shop.id, owner)).rejects.toMatchObject({ status: 409 });
  });

  it("a second payment for a period already renewed is recorded as an adjustment and extends nothing", async () => {
    await checkoutOn();
    const { owner, shop } = await liveShop(10);
    const open = await startMembershipRenewalCheckout(shop.id, owner);
    // Meanwhile the office records the renewal in cash.
    await recordPayment({ shopId: shop.id, paymentType: "RENEWAL", amountPaise: FEE }, admin);
    const renewedTo = (await shopRow(shop.id)).membershipValidUntil;

    await simulateSandboxCheckout({ ref: open.intentId, viewerId: owner.id, outcome: "SUCCESS" });
    expect((await shopRow(shop.id)).membershipValidUntil?.getTime()).toBe(renewedTo?.getTime());
    const adjustments = await db.select().from(shopPayments).where(and(eq(shopPayments.shopId, shop.id), eq(shopPayments.paymentType, "ADJUSTMENT")));
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].note).toContain("Duplicate membership renewal");
  });

  it("a failed payment can be retried with a new checkout", async () => {
    await checkoutOn();
    const { owner, shop, until } = await liveShop(10);
    const failed = await startMembershipRenewalCheckout(shop.id, owner);
    await simulateSandboxCheckout({ ref: failed.intentId, viewerId: owner.id, outcome: "FAILURE" });
    expect((await shopRow(shop.id)).membershipValidUntil?.getTime()).toBe(until.getTime());
    const retry = await startMembershipRenewalCheckout(shop.id, owner);
    expect(retry.intentId).not.toBe(failed.intentId);
  });

  it("another owner cannot start a renewal for the shop", async () => {
    await checkoutOn();
    const { shop } = await liveShop(10);
    const stranger = await createUser({ role: "SHOP_OWNER" });
    await expect(startMembershipRenewalCheckout(shop.id, stranger)).rejects.toMatchObject({ status: 404 });
  });
});

describe("OFF switches and exemptions", () => {
  it("reminders off: nothing is sent; on: one reminder per stage", async () => {
    const { shop } = await liveShop(5);
    expect(await runMembershipRenewalReminders()).toMatchObject({ sent: 0, skipped: expect.any(String) });
    await setRule("shopMembership", { remindersEnabled: true }, admin);
    clearRuleCache();
    expect((await runMembershipRenewalReminders()).sent).toBe(1);
    await runMembershipRenewalReminders();
    const sent = await db.select().from(notifications).where(and(eq(notifications.userId, shop.ownerId), eq(notifications.type, "shop.membership_renewal_due")));
    expect(sent).toHaveLength(1);
  });

  it("an exempt shop stays online after its membership lapsed (per shop, audited; by shop type)", async () => {
    const { shop } = await liveShop(-40);
    expect((await withWalletGate([await shopRow(shop.id)]))[0].ordersPaused).toBe(true);

    await expect(setMembershipExemption(shop.id, { exempt: true, reason: "Temple trust shop" }, { id: shop.ownerId, role: "SHOP_OWNER" })).rejects.toMatchObject({ status: 403 });
    await setMembershipExemption(shop.id, { exempt: true, reason: "Temple trust shop" }, admin);
    expect((await withWalletGate([await shopRow(shop.id)]))[0].ordersPaused).toBe(false);
    await setMembershipExemption(shop.id, { exempt: false, reason: "Trust status ended" }, admin);
    expect((await withWalletGate([await shopRow(shop.id)]))[0].ordersPaused).toBe(true);

    await setRule("shopMembership", { exemptShopTypes: [shop.shopType] }, admin);
    clearRuleCache();
    expect((await withWalletGate([await shopRow(shop.id)]))[0].ordersPaused).toBe(false);
  });

  it("membership switched off closes nobody", async () => {
    const { shop } = await liveShop(-400);
    await setRule("shopMembership", { enabled: false }, admin);
    clearRuleCache();
    expect((await withWalletGate([await shopRow(shop.id)]))[0].ordersPaused).toBe(false);
  });
});
