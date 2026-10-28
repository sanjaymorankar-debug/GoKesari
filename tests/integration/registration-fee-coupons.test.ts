/**
 * Add my shop: the one-time registration fee with coupon and GST (owner,
 * 27 Oct 2026).
 *
 *   - base fee: Admin → Registration fee (₹999), admin only, applies to every
 *     new registration
 *   - a registration-fee coupon (admin-managed) reduces the base fee
 *   - GST (Admin → Statutory, PLATFORM_FEE_GST: 18%) is added on the rest
 *   - the total is what the owner pays on the next screen
 */
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

import { GET as couponsGet, POST as couponsPost } from "@/app/api/admin/registration-fee-coupons/route";
import { PUT as couponPut } from "@/app/api/admin/registration-fee-coupons/[id]/route";
import { GET as quoteGet } from "@/app/api/shops/registration-fee-quote/route";
import { POST as registerRoute } from "@/app/api/shops/route";
import { POST as feeRoute } from "@/app/api/shops/[id]/registration-fee/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { shopCategories, shops } from "@/server/db/schema";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { checkRegistrationFeePayment } from "@/server/services/registration-fee-payment";
import { saveRegistrationFeeCoupon } from "@/server/services/registration-fee-coupons";
import { setRegistrationFee } from "@/server/services/registration-fees";
import { clearRuleCache } from "@/server/services/settings";
import { registerShop } from "@/server/services/shops";
import { createUser, resetDatabase } from "../helpers/fixtures";
import { call } from "../helpers/http";

let counter = 0;

function shopInput(extra: Record<string, unknown> = {}) {
  counter += 1;
  return {
    name: `Coupon Dairy ${counter}`,
    ownerName: "Ramesh Patil",
    phone: "9876543210",
    addressLine1: `${counter} JM Road`,
    city: "Pune",
    pincode: "411004",
    shopType: "DAIRY" as const,
    shopActNumber: `PII/SHIVAJINAGAR/II/${40000 + counter}`,
    ...extra,
  };
}

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole = "CUSTOMER") {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

const asActor = (u: { id: string; role: UserRole }) => ({ id: u.id, role: u.role });

let admin: Awaited<ReturnType<typeof createUser>>;

async function coupon(input: Partial<Parameters<typeof saveRegistrationFeeCoupon>[0]> = {}) {
  return saveRegistrationFeeCoupon(
    { code: `CPN${(counter += 1)}`, discountType: "FLAT", flatPaise: 20_000, ...input },
    asActor(admin),
  );
}

async function categoryIds() {
  const tag = crypto.randomUUID().slice(0, 8);
  const [row] = await db.insert(shopCategories).values({ name: `Coupon test ${tag}`, slug: `coupon-test-${tag}` }).returning();
  return [row.id];
}

beforeEach(async () => {
  state.session = null;
  resetRateLimits();
  clearRuleCache();
  await resetDatabase();
  admin = await createUser({ role: "ADMIN" });
  // As configured on the sites: base fee ₹999.
  await setRegistrationFee({ amountPaise: 99_900 }, asActor(admin));
});

describe("the fee is the base fee plus GST", () => {
  it("₹999 + 18% GST = ₹1,178.82, with the breakdown kept on the shop", async () => {
    const shop = await registerShop(shopInput(), asActor(await createUser()));
    expect(shop).toMatchObject({
      registrationFeePaise: 1_17_882,
      registrationFeeBasePaise: 99_900,
      registrationFeeDiscountPaise: 0,
      registrationFeeGstPaise: 17_982,
      registrationFeeGstRateBp: 1800,
      registrationFeeCouponId: null,
      feePaymentStatus: "PENDING",
    });
  });

  it("an admin's new base fee applies to every new registration, not to shops already registered", async () => {
    const before = await registerShop(shopInput(), asActor(await createUser()));
    await setRegistrationFee({ amountPaise: 1_49_900 }, asActor(admin));
    const after = await registerShop(shopInput(), asActor(await createUser()));
    expect(after.registrationFeePaise).toBe(1_49_900 + 26_982);
    const [kept] = await db.select().from(shops).where(eq(shops.id, before.id));
    expect(kept.registrationFeePaise).toBe(1_17_882);
  });

  it("only an admin can change the base fee or manage coupons", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    signIn(operator, "OPERATOR");
    const list = await call(couponsGet, "/api/admin/registration-fee-coupons");
    expect(list.status).toBe(403);
    const create = await call(couponsPost, "/api/admin/registration-fee-coupons", {
      method: "POST",
      body: { code: "NOPE1", discountType: "FLAT", flatPaise: 100 },
    });
    expect(create.status).toBe(403);
  });
});

describe("a coupon reduces the base fee; GST is on what is left", () => {
  it("₹200 off: (₹999 − ₹200) + 18% = ₹942.82", async () => {
    const c = await coupon({ flatPaise: 20_000 });
    const shop = await registerShop(shopInput({ couponCode: c.code.toLowerCase() }), asActor(await createUser()));
    expect(shop).toMatchObject({
      registrationFeeBasePaise: 99_900,
      registrationFeeDiscountPaise: 20_000,
      registrationFeeGstPaise: 14_382,
      registrationFeePaise: 94_282,
      registrationFeeCouponId: c.id,
      registrationFeeCouponCode: c.code,
    });
  });

  it("a percentage coupon is capped; a 100% coupon leaves nothing to pay", async () => {
    const capped = await coupon({ discountType: "PERCENT", flatPaise: null, percent: 50, maxDiscountPaise: 30_000 });
    const a = await registerShop(shopInput({ couponCode: capped.code }), asActor(await createUser()));
    expect(a.registrationFeeDiscountPaise).toBe(30_000);
    expect(a.registrationFeePaise).toBe(69_900 + 12_582);

    const free = await coupon({ discountType: "PERCENT", flatPaise: null, percent: 100 });
    const b = await registerShop(shopInput({ couponCode: free.code }), asActor(await createUser()));
    expect(b).toMatchObject({ registrationFeePaise: 0, registrationFeeGstPaise: 0, feePaymentStatus: "PAID" });
  });

  it("refuses an unknown, switched-off, expired or not-yet-started coupon, next to the field, and saves nothing", async () => {
    const off = await coupon({ active: false });
    const expired = await coupon({ expiresAt: new Date(Date.now() - 60_000) });
    const later = await coupon({ startsAt: new Date(Date.now() + 86_400_000) });
    for (const code of ["NOSUCHCODE", off.code, expired.code, later.code]) {
      await expect(registerShop(shopInput({ couponCode: code }), asActor(await createUser())), code).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        details: { fields: { couponCode: expect.any(String) } },
      });
    }
    expect(await db.select().from(shops)).toHaveLength(0);
  });

  it("keeps to its limits: total uses, and uses per owner", async () => {
    const once = await coupon({ usageLimit: 1, perOwnerLimit: null });
    await registerShop(shopInput({ couponCode: once.code }), asActor(await createUser()));
    await expect(registerShop(shopInput({ couponCode: once.code }), asActor(await createUser()))).rejects.toMatchObject({
      details: { fields: { couponCode: "This coupon has been fully used." } },
    });

    // An operator registering two shops for one owner: one use per owner.
    const perOwner = await coupon({ perOwnerLimit: 1 });
    const operator = await createUser({ role: "ADMIN" });
    const owner = await createUser();
    await registerShop(shopInput({ ownerId: owner.id, couponCode: perOwner.code }), asActor(operator), { privileged: true });
    await expect(
      registerShop(shopInput({ ownerId: owner.id, couponCode: perOwner.code }), asActor(operator), { privileged: true }),
    ).rejects.toMatchObject({ details: { fields: { couponCode: "You've already used this coupon." } } });
  });

  it("two registrations racing for the last use: exactly one gets it", async () => {
    const last = await coupon({ usageLimit: 1, perOwnerLimit: null });
    const results = await Promise.allSettled([
      registerShop(shopInput({ couponCode: last.code }), asActor(await createUser())),
      registerShop(shopInput({ couponCode: last.code }), asActor(await createUser())),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await db.select().from(shops).where(eq(shops.registrationFeeCouponId, last.id));
    expect(rows).toHaveLength(1);
  });

  it("an operator's fee override is the total: no coupon, no GST added", async () => {
    const operator = await createUser({ role: "ADMIN" });
    const c = await coupon();
    const shop = await registerShop(
      { ...shopInput({ couponCode: c.code }), ownerId: (await createUser()).id, registrationFeePaise: 50_000 },
      asActor(operator),
      { privileged: true },
    );
    expect(shop).toMatchObject({ registrationFeePaise: 50_000, registrationFeeCouponId: null, registrationFeeGstPaise: null });
  });
});

describe("the owner's screens", () => {
  it("the form's quote: base, coupon and GST; a bad coupon is refused next to the field", async () => {
    const owner = await createUser();
    signIn(owner);
    const plain = await call(quoteGet, "/api/shops/registration-fee-quote");
    expect(plain.status).toBe(200);
    expect(plain.body).toMatchObject({ basePaise: 99_900, discountPaise: 0, gstRateBp: 1800, gstPaise: 17_982, totalPaise: 1_17_882, couponCode: null });

    const c = await coupon({ description: "Launch offer" });
    const withCoupon = await call(quoteGet, `/api/shops/registration-fee-quote?coupon=${c.code.toLowerCase()}`);
    expect(withCoupon.body).toMatchObject({ discountPaise: 20_000, totalPaise: 94_282, couponCode: c.code, couponDescription: "Launch offer" });

    const bad = await call(quoteGet, "/api/shops/registration-fee-quote?coupon=NOSUCHCODE");
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.fields.couponCode).toBe("That coupon code isn't valid.");
  });

  it("Submit with a coupon, then pay the total online", async () => {
    const owner = await createUser();
    signIn(owner);
    const c = await coupon();
    const created = await call(registerRoute, "/api/shops", {
      method: "POST",
      // A fee in the body is ignored for the owner; the server prices it.
      // Turnover ₹15 lakh: slab 1, ₹999 — the owner must declare it while the slabs are on.
      body: { ...shopInput({ couponCode: c.code, annualTurnoverRupees: 15_00_000 }), categoryIds: await categoryIds(), registrationFeePaise: 100 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ registrationFeePaise: 94_282, feePaymentStatus: "PENDING" });

    const checkout = await call(feeRoute, `/api/shops/${created.body.id}/registration-fee`, { method: "POST", params: { id: created.body.id } });
    expect(checkout.status).toBe(201);
    expect(checkout.body.amountPaise).toBe(94_282);
    await simulateSandboxCheckout({ ref: checkout.body.intentId, viewerId: owner.id, outcome: "SUCCESS" });
    const paid = await checkRegistrationFeePayment(created.body.id, checkout.body.intentId, owner.id);
    expect(paid).toMatchObject({ feePaymentStatus: "PAID", amountPaidPaise: 94_282 });
  });

  it("an admin creates, lists and switches off a coupon; a switched-off coupon no longer applies", async () => {
    signIn(admin, "ADMIN");
    const created = await call(couponsPost, "/api/admin/registration-fee-coupons", {
      method: "POST",
      body: { code: " launch50 ", discountType: "PERCENT", percent: 50, description: "Launch" },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ code: "LAUNCH50", perOwnerLimit: 1, active: true });

    const dup = await call(couponsPost, "/api/admin/registration-fee-coupons", {
      method: "POST",
      body: { code: "LAUNCH50", discountType: "FLAT", flatPaise: 100 },
    });
    expect(dup.status).toBe(409);

    await registerShop(shopInput({ couponCode: "LAUNCH50" }), asActor(await createUser()));
    const list = await call(couponsGet, "/api/admin/registration-fee-coupons");
    expect(list.body.coupons).toEqual([expect.objectContaining({ code: "LAUNCH50", uses: 1 })]);

    const off = await call(couponPut, `/api/admin/registration-fee-coupons/${created.body.id}`, {
      method: "PUT",
      params: { id: created.body.id },
      body: { code: "LAUNCH50", discountType: "PERCENT", percent: 50, active: false },
    });
    expect(off.status).toBe(200);
    await expect(registerShop(shopInput({ couponCode: "LAUNCH50" }), asActor(await createUser()))).rejects.toMatchObject({
      details: { fields: { couponCode: "That coupon code isn't valid." } },
    });
  });
});
