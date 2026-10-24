/**
 * Live-path payment confirmation (§18, §20, §48) — `verifyAndCreditTopUp`
 * calling Cashfree's Get Order Payments API server-to-server.
 *
 * `global.fetch` is stubbed rather than hitting the real sandbox here, so
 * this suite is deterministic and offline; the real sandbox integration was
 * separately smoke-tested by hand against the actual Cashfree API during
 * development (order creation + status fetch both confirmed working).
 * Since TC-PAY-004 `verifyAndCreditTopUp` asks Cashfree only for a Cashfree
 * payment while keys are set (a MOCK one is never sent to Cashfree), so each
 * test creates the top-up offline and then marks it a Cashfree order with
 * keys "configured" (cashfreeTopUp below).
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getEnv } from "@/lib/env";
import { db } from "@/server/db";
import { payments, wallets } from "@/server/db/schema";
import { createTopUpOrder, verifyAndCreditTopUp } from "@/server/services/payments";
import { createUserWithWallet, resetDatabase } from "../helpers/fixtures";

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }),
  );
}

const balanceOf = async (userId: string) =>
  (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))!
    .balancePaise;

const env = getEnv() as { CASHFREE_APP_ID?: string };
const appIdBefore = env.CASHFREE_APP_ID;

/** A top-up created offline, then turned into a Cashfree order with (fake) keys set — verify asks Cashfree for it. */
async function cashfreeTopUp(userId: string, amountPaise: number) {
  const intent = await createTopUpOrder(userId, amountPaise);
  await db.update(payments).set({ gateway: "CASHFREE" }).where(eq(payments.gatewayOrderId, intent.gatewayOrderId));
  env.CASHFREE_APP_ID = "test-app";
  return intent;
}

describe("verifyAndCreditTopUp — live Cashfree confirmation", () => {
  beforeEach(resetDatabase);
  afterEach(() => {
    vi.unstubAllGlobals();
    env.CASHFREE_APP_ID = appIdBefore;
  });

  it("credits the wallet when Cashfree reports a SUCCESS payment attempt", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const intent = await cashfreeTopUp(user.id, 500_000);

    mockFetchOnce(200, [
      { cf_payment_id: "cf_pay_1", payment_status: "SUCCESS" },
    ]);

    const result = await verifyAndCreditTopUp({
      userId: user.id,
      gatewayOrderId: intent.gatewayOrderId,
    });

    expect(result.balancePaise).toBe(500_000);
    expect(await balanceOf(user.id)).toBe(500_000);
  });

  it("picks the SUCCESS attempt out of several (e.g. a failed retry followed by success)", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const intent = await cashfreeTopUp(user.id, 200_000);

    mockFetchOnce(200, [
      { cf_payment_id: "cf_pay_failed", payment_status: "FAILED" },
      { cf_payment_id: "cf_pay_ok", payment_status: "SUCCESS" },
    ]);

    const result = await verifyAndCreditTopUp({
      userId: user.id,
      gatewayOrderId: intent.gatewayOrderId,
    });

    expect(result.balancePaise).toBe(200_000);
  });

  it("fails closed when Cashfree reports no successful attempt yet", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const intent = await cashfreeTopUp(user.id, 300_000);

    mockFetchOnce(200, []);

    await expect(
      verifyAndCreditTopUp({ userId: user.id, gatewayOrderId: intent.gatewayOrderId }),
    ).rejects.toMatchObject({ code: "PAYMENT_VERIFICATION_FAILED" });

    expect(await balanceOf(user.id)).toBe(0);
  });

  it("fails closed when the Cashfree API call itself errors", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const intent = await cashfreeTopUp(user.id, 300_000);

    mockFetchOnce(500, { message: "internal error" });

    await expect(
      verifyAndCreditTopUp({ userId: user.id, gatewayOrderId: intent.gatewayOrderId }),
    ).rejects.toMatchObject({ code: "PAYMENT_VERIFICATION_FAILED" });

    expect(await balanceOf(user.id)).toBe(0);
  });

  it("does not credit twice when confirmed twice (replay via client + webhook race)", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const intent = await cashfreeTopUp(user.id, 400_000);

    mockFetchOnce(200, [{ cf_payment_id: "cf_pay_dup", payment_status: "SUCCESS" }]);

    const first = await verifyAndCreditTopUp({
      userId: user.id,
      gatewayOrderId: intent.gatewayOrderId,
    });
    const second = await verifyAndCreditTopUp({
      userId: user.id,
      gatewayOrderId: intent.gatewayOrderId,
    });

    expect(first.alreadyProcessed).toBe(false);
    expect(second.alreadyProcessed).toBe(true);
    expect(await balanceOf(user.id)).toBe(400_000);
  });

  it("refuses to let one user confirm another user's payment", async () => {
    const { user: payer } = await createUserWithWallet({ balancePaise: 0 });
    const { user: attacker } = await createUserWithWallet({ balancePaise: 0 });
    const intent = await cashfreeTopUp(payer.id, 400_000);

    mockFetchOnce(200, [{ cf_payment_id: "cf_pay_hijack", payment_status: "SUCCESS" }]);

    await expect(
      verifyAndCreditTopUp({ userId: attacker.id, gatewayOrderId: intent.gatewayOrderId }),
    ).rejects.toMatchObject({ code: "PAYMENT_VERIFICATION_FAILED" });

    expect(await balanceOf(attacker.id)).toBe(0);
    expect(await balanceOf(payer.id)).toBe(0);
  });
});
