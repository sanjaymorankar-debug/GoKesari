/**
 * Add my shop: the one-time registration fee, and the owner paying it online.
 *
 *   - owner, 27 Oct 2026: a flat ₹999 for now (Admin → Registration fee); the
 *     form asks no turnover
 *   - owner, 26 Oct 2026, kept switched off: turnover up to ₹2 crore → ₹999;
 *     above → ₹4,999 (rule registrationFeeByTurnover)
 *   - the fee is computed on the server and snapshotted on the shop
 *   - a self-service registration must declare its turnover
 *   - the owner pays through the sandbox gateway; the shop's fee becomes PAID
 *     once, however often the checkout is opened or the webhook replayed
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as registerRoute } from "@/app/api/shops/route";
import { POST as feeRoute } from "@/app/api/shops/[id]/registration-fee/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { shopCategories, shopPayments, shops } from "@/server/db/schema";
import { listIntentsFor } from "@/server/payments/intents";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { setRegistrationFee } from "@/server/services/registration-fees";
import {
  checkRegistrationFeePayment,
  registrationFeeDue,
  startRegistrationFeeCheckout,
} from "@/server/services/registration-fee-payment";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { registerShop } from "@/server/services/shops";
import { createUser, resetDatabase } from "../helpers/fixtures";
import { call } from "../helpers/http";

const CRORE = 1_00_00_000;
/** The total payable on a base fee: 18% GST added (owner, 27 Oct 2026). */
const withGst = (basePaise: number) => basePaise + Math.round((basePaise * 1800) / 10_000);
let counter = 0;

function shopInput(turnover: number | null, extra: Record<string, unknown> = {}) {
  counter += 1;
  return {
    name: `Turnover Dairy ${counter}`,
    ownerName: "Ramesh Patil",
    phone: "9876543210",
    addressLine1: `${counter} FC Road`,
    city: "Pune",
    pincode: "411004",
    shopType: "DAIRY" as const,
    shopActNumber: `PII/KOTHRUD/II/${30000 + counter}`,
    annualTurnoverRupees: turnover,
    ...extra,
  };
}

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole = "CUSTOMER") {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

const asActor = (u: { id: string; role: UserRole }) => ({ id: u.id, role: u.role });

beforeEach(async () => {
  state.session = null;
  resetRateLimits();
  clearRuleCache();
  await resetDatabase();
  // As configured on the sites: a flat ₹999.
  await setRegistrationFee({ amountPaise: 99_900 }, asActor(await createUser({ role: "ADMIN" })));
});

/** Switches the turnover tiers on, as an admin would. */
async function turnoverRuleOn() {
  await setRule("registrationFeeByTurnover", { enabled: true }, asActor(await createUser({ role: "ADMIN" })));
  clearRuleCache();
}

describe("a flat ₹999 by default", () => {
  it("charges every new shop the flat fee, whatever turnover it declares", async () => {
    for (const turnover of [null, 15_00_000, 50 * CRORE]) {
      const shop = await registerShop(shopInput(turnover), asActor(await createUser()));
      expect(shop.registrationFeePaise, `turnover ${turnover}`).toBe(withGst(99_900));
      expect(shop.registrationFeeBasePaise).toBe(99_900);
      expect(shop.feePaymentStatus).toBe("PENDING");
      expect(shop.registrationFeeId).not.toBeNull();
    }
  });
});

describe("the fee follows the declared turnover (when an admin switches it on)", () => {
  beforeEach(turnoverRuleOn);

  it("₹999 up to and including ₹2 crore, ₹4,999 above — snapshotted with the turnover", async () => {
    const cases: [number, number][] = [
      [15_00_000, 99_900],
      [2 * CRORE, 99_900],
      [2 * CRORE + 1, 4_99_900],
      [25 * CRORE, 4_99_900],
    ];
    for (const [turnover, fee] of cases) {
      const owner = await createUser();
      const shop = await registerShop(shopInput(turnover), asActor(owner));
      expect(shop.registrationFeePaise, `turnover ${turnover}`).toBe(withGst(fee));
      expect(shop.annualTurnoverRupees).toBe(turnover);
      expect(shop.feePaymentStatus).toBe("PENDING");
      // Provenance: not the flat schedule's row.
      expect(shop.registrationFeeId).toBeNull();
    }
  });

  it("uses the flat schedule when the rule is switched off, or no turnover was declared", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await setRegistrationFee({ amountPaise: 10_000 }, asActor(admin));

    const noTurnover = await registerShop(shopInput(null), asActor(await createUser()));
    expect(noTurnover.registrationFeePaise).toBe(withGst(10_000));

    await setRule("registrationFeeByTurnover", { enabled: false }, asActor(admin));
    clearRuleCache();
    const ruleOff = await registerShop(shopInput(50 * CRORE), asActor(await createUser()));
    expect(ruleOff.registrationFeePaise).toBe(withGst(10_000));
    expect(ruleOff.registrationFeeId).not.toBeNull();
  });

  it("follows an admin's new amounts for new shops and leaves registered shops as they were", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const before = await registerShop(shopInput(1 * CRORE), asActor(await createUser()));
    await setRule("registrationFeeByTurnover", { enabled: true, upToFeePaise: 1_49_900 }, asActor(admin));
    clearRuleCache();
    const after = await registerShop(shopInput(1 * CRORE), asActor(await createUser()));

    expect(after.registrationFeePaise).toBe(withGst(1_49_900));
    const [kept] = await db.select().from(shops).where(eq(shops.id, before.id));
    expect(kept.registrationFeePaise).toBe(withGst(99_900));
  });

  it("an operator's fee override still wins", async () => {
    const operator = await createUser({ role: "ADMIN" });
    const owner = await createUser();
    const shop = await registerShop(
      { ...shopInput(50 * CRORE), ownerId: owner.id, registrationFeePaise: 0 },
      asActor(operator),
      { privileged: true },
    );
    expect(shop.registrationFeePaise).toBe(0);
    expect(shop.feePaymentStatus).toBe("PAID");
  });

  it("refuses a negative or fractional turnover", async () => {
    const owner = await createUser();
    for (const bad of [-1, 1.5]) {
      await expect(registerShop(shopInput(bad), asActor(owner))).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        details: { fields: { annualTurnover: expect.any(String) } },
      });
    }
  });
});

describe("POST /api/shops (Add my shop)", () => {
  async function categoryIds() {
    // Categories survive resetDatabase(): a unique name and slug per call.
    const tag = randomUUID().slice(0, 8);
    const [row] = await db.insert(shopCategories).values({ name: `Turnover test ${tag}`, slug: `turnover-test-${tag}` }).returning();
    return [row.id];
  }

  it("asks no turnover by default and computes the fee itself", async () => {
    const owner = await createUser();
    signIn(owner);
    // A fee in the body is an operator-only field: ignored for the owner.
    const created = await call(registerRoute, "/api/shops", {
      method: "POST",
      body: { ...shopInput(null), categoryIds: await categoryIds(), registrationFeePaise: 100 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ registrationFeePaise: withGst(99_900), annualTurnoverRupees: null, feePaymentStatus: "PENDING" });
  });

  it("with the turnover rule on, requires the turnover and computes the fee itself", async () => {
    await turnoverRuleOn();
    const owner = await createUser();
    signIn(owner);
    const ids = await categoryIds();

    const missing = await call(registerRoute, "/api/shops", { method: "POST", body: { ...shopInput(null), categoryIds: ids } });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details.fields.annualTurnover).toContain("turnover");

    // A fee in the body is an operator-only field: ignored for the owner.
    const created = await call(registerRoute, "/api/shops", {
      method: "POST",
      body: { ...shopInput(3 * CRORE), categoryIds: ids, registrationFeePaise: 100 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ registrationFeePaise: withGst(4_99_900), annualTurnoverRupees: 3 * CRORE, feePaymentStatus: "PENDING" });
  });

  it("refuses a second, different shop while the first waits for approval", async () => {
    const owner = await createUser();
    signIn(owner);
    const ids = await categoryIds();
    const first = await call(registerRoute, "/api/shops", { method: "POST", body: { ...shopInput(10_00_000), categoryIds: ids } });
    expect(first.status).toBe(201);

    const second = await call(registerRoute, "/api/shops", { method: "POST", body: { ...shopInput(10_00_000), categoryIds: ids } });
    expect(second.status).toBe(409);
    expect(second.body.error.details).toMatchObject({ reason: "REGISTRATION_PENDING", shopId: first.body.id });
    expect(await db.select().from(shops)).toHaveLength(1);
  });

  it("accepts the professional shop types", async () => {
    const owner = await createUser();
    signIn(owner);
    const res = await call(registerRoute, "/api/shops", {
      method: "POST",
      body: { ...shopInput(40_00_000, { shopType: "DOCTOR_CLINIC", name: "Ekdant Dental Clinic" }), categoryIds: await categoryIds() },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ shopType: "DOCTOR_CLINIC", registrationFeePaise: withGst(99_900) });
  });
});

describe("the owner pays the fee online", () => {
  it("opens one checkout for what is due; payment marks the fee PAID once", async () => {
    const owner = await createUser();
    const shop = await registerShop(shopInput(15_00_000), asActor(owner));
    signIn(owner);

    const first = await call(feeRoute, `/api/shops/${shop.id}/registration-fee`, { method: "POST", params: { id: shop.id } });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.amountPaise).toBe(withGst(99_900));
    expect(typeof first.body.redirectUrl).toBe("string");

    // A second press reuses the open checkout: one payment, not two.
    const again = await call(feeRoute, `/api/shops/${shop.id}/registration-fee`, { method: "POST", params: { id: shop.id } });
    expect(again.body.intentId).toBe(first.body.intentId);
    expect(await listIntentsFor("SHOP_REGISTRATION_FEE", shop.id)).toHaveLength(1);

    const done = await simulateSandboxCheckout({ ref: first.body.intentId, viewerId: owner.id, outcome: "SUCCESS" });
    expect(done.returnPath).toContain(`/shop/registration-fee?shop=${shop.id}`);

    const settled = await checkRegistrationFeePayment(shop.id, first.body.intentId, owner.id);
    expect(settled.feePaymentStatus).toBe("PAID");
    expect(settled.amountPaidPaise).toBe(withGst(99_900));
    expect(registrationFeeDue(settled)).toBe(0);
    const ledger = await db.select().from(shopPayments).where(eq(shopPayments.shopId, shop.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ paymentType: "REGISTRATION_FEE", method: "ONLINE", amountPaise: withGst(99_900) });

    // Paid: nothing more can be charged.
    const after = await call(feeRoute, `/api/shops/${shop.id}/registration-fee`, { method: "POST", params: { id: shop.id } });
    expect(after.status).toBe(409);
  });

  it("a failed payment can be retried with a new checkout", async () => {
    const owner = await createUser();
    const shop = await registerShop(shopInput(15_00_000), asActor(owner));
    const failed = await startRegistrationFeeCheckout(shop.id, owner);
    await simulateSandboxCheckout({ ref: failed.intentId, viewerId: owner.id, outcome: "FAILURE" });
    const still = await checkRegistrationFeePayment(shop.id, failed.intentId, owner.id);
    expect(still.feePaymentStatus).toBe("PENDING");

    const retry = await startRegistrationFeeCheckout(shop.id, owner);
    expect(retry.intentId).not.toBe(failed.intentId);
    await simulateSandboxCheckout({ ref: retry.intentId, viewerId: owner.id, outcome: "SUCCESS" });
    expect((await checkRegistrationFeePayment(shop.id, retry.intentId, owner.id)).feePaymentStatus).toBe("PAID");
  });

  it("another account cannot start or check a shop's fee", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const shop = await registerShop(shopInput(15_00_000), asActor(owner));
    signIn(stranger);
    const res = await call(feeRoute, `/api/shops/${shop.id}/registration-fee`, { method: "POST", params: { id: shop.id } });
    expect(res.status).toBe(404);
    await expect(checkRegistrationFeePayment(shop.id, null, stranger.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
