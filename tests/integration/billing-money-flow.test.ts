/**
 * Billing v2 phase 1 (docs/billing): the money-flow record written with each
 * delivered order — mode, who received the money, TCS / TDS scope, and the
 * s.9(5) decision on the delivery fee (build prompt §5.1, §5.2; scenarios 3,
 * 4 and 7 of §13). Works on both database layouts: shops and their GST type
 * are seller-side, orders and order_money_flows customer-side.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { deliveryPartners, featureFlags, orderFulfilmentArrangements, orderMoneyFlows, orders, shops, type FeatureFlagKey } from "@/server/db/schema";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { recordOrderMoneyFlow } from "@/server/tax/money-flow";
import { getShopRegistration, setShopRegistration } from "@/server/tax/registration";
import { deliveredOrder, gstShop, resetBatchE, rules } from "../helpers/batch-e";
import { createDeliveryPartner, createUser, resetDatabase } from "../helpers/fixtures";

async function flag(key: FeatureFlagKey, enabled: boolean) {
  await db.insert(featureFlags).values({ key, enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
}

async function rerecord(orderId: string, at?: Date) {
  await db.delete(orderMoneyFlows).where(eq(orderMoneyFlows.orderId, orderId));
  return recordOrderMoneyFlow(orderId, db, at);
}

describe("billing v2 money flow", () => {
  let admin: { id: string; role: "ADMIN" };

  beforeEach(async () => {
    await resetDatabase();
    await resetBatchE();
    await db.execute(sql`DELETE FROM feature_flags WHERE key IN ('billing_v2', 'delivery_9_5')`);
    const a = await createUser({ role: "ADMIN" });
    admin = { id: a.id, role: "ADMIN" };
  });

  it("records nothing while billing_v2 is off", async () => {
    const { milkSp } = await gstShop();
    const { order } = await deliveredOrder(admin, [[milkSp.id, 2]]);
    expect(await db.select().from(orderMoneyFlows).where(eq(orderMoneyFlows.orderId, order.id))).toEqual([]);
  });

  it("a flag limited to districts records only the orders of shops there (QA D-110)", async () => {
    await setFeatureFlag("billing_v2", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", admin);
    const { shop, milkSp } = await gstShop();
    await db.update(shops).set({ pincode: "411001" }).where(eq(shops.id, shop.id));
    const { order } = await deliveredOrder(admin, [[milkSp.id, 2]]);
    expect(await db.select().from(orderMoneyFlows).where(eq(orderMoneyFlows.orderId, order.id))).toHaveLength(1);
    // The same shop outside the pilot district: nothing is recorded.
    await db.update(shops).set({ pincode: "400001" }).where(eq(shops.id, shop.id));
    expect(await rerecord(order.id)).toBeNull();
  });

  it("a prepaid order delivered by a GoKesari partner: GoKesari received the money, TCS and TDS in scope", async () => {
    await flag("billing_v2", true);
    const { milkSp } = await gstShop();
    const { order } = await deliveredOrder(admin, [[milkSp.id, 2]]);
    const [row] = await db.select().from(orderMoneyFlows).where(eq(orderMoneyFlows.orderId, order.id));
    expect(row).toMatchObject({
      paymentMethod: "WALLET",
      fulfilment: "GOKESARI_PARTNER",
      mode: "WALLET_PREPAID",
      collectedBy: "PLATFORM",
      tcsApplicable: true,
      tdsApplicable: true,
      settlementStatus: "UNSETTLED",
    });
    // A GSTIN verified after migration 0125 counts through gst_status.
    expect((row.ruleSnapshot as { registrationType: string }).registrationType).toBe("REGULAR");
    // Recorded once: delivering again (a dispute resolved for the shop) keeps the first record.
    expect(await recordOrderMoneyFlow(order.id)).toBeNull();
  });

  it("an Enrolment-ID shop: no TCS, TDS still in scope", async () => {
    await flag("billing_v2", true);
    const { shop, milkSp, owner } = await gstShop({ gstin: null });
    // The owner declares it on the shop's GST page (§3.1).
    await expect(setShopRegistration(shop.id, { type: "ENROLMENT_ID" }, owner)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await setShopRegistration(shop.id, { type: "ENROLMENT_ID", enrolmentId: "271234567890eid" }, owner)).toMatchObject({ type: "ENROLMENT_ID", declared: "ENROLMENT_ID", enrolmentId: "271234567890EID", hasGstin: false });
    const { order } = await deliveredOrder(admin, [[milkSp.id, 1]]);
    const [row] = await db.select().from(orderMoneyFlows).where(eq(orderMoneyFlows.orderId, order.id));
    expect(row).toMatchObject({ tcsApplicable: false, tdsApplicable: true });
    expect(await setShopRegistration(shop.id, { type: "BY_GSTIN" }, owner)).toMatchObject({ type: "UNREGISTERED", enrolmentId: null });
  });

  it("a shop with a GSTIN cannot declare an Enrolment ID or PAN-only service", async () => {
    const { shop, owner } = await gstShop();
    await expect(setShopRegistration(shop.id, { type: "PAN_ONLY_SERVICE" }, owner)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await getShopRegistration(shop.id)).toMatchObject({ type: "REGULAR", declared: "BY_GSTIN", hasGstin: true });
  });

  it("cash taken by the shop's own delivery person: the shop received it; the CA switch decides TCS", async () => {
    await flag("billing_v2", true);
    const { shop, milkSp } = await gstShop();
    const { order } = await deliveredOrder(admin, [[milkSp.id, 1]]);
    await db.update(orders).set({ paymentMethod: "COD" }).where(eq(orders.id, order.id));
    const now = new Date();
    await db.insert(orderFulfilmentArrangements).values({
      orderId: order.id,
      shopId: shop.id,
      option: "SHOP_DELIVERY",
      scheduledStart: now,
      scheduledEnd: new Date(now.getTime() + 3_600_000),
      completedAt: now,
      completedVia: "DELIVERY_CODE",
    });
    expect(await rerecord(order.id)).toMatchObject({ mode: "COD_SHOP", collectedBy: "SHOP", tcsApplicable: true, tdsApplicable: true, deliveryGstLiable: expect.stringMatching(/SHOP|NONE/) });

    await rules(admin, { billing: { tcsWhenShopCollects: false, tdsWhenShopCollects: false } });
    expect(await rerecord(order.id)).toMatchObject({ collectedBy: "SHOP", tcsApplicable: false, tdsApplicable: false });
  });

  it("s.9(5) delivery GST: 18% on 31 Oct 2026, 5% from 1 Nov 2026, none for a registered rider", async () => {
    await flag("billing_v2", true);
    await flag("delivery_9_5", true);
    const { milkSp } = await gstShop();
    const { order } = await deliveredOrder(admin, [[milkSp.id, 2]]);
    await db.update(orders).set({ deliveryFeePaise: 2_100 }).where(eq(orders.id, order.id));

    const oct31 = await rerecord(order.id, new Date("2026-10-31T12:00:00+05:30"));
    expect(oct31).toMatchObject({ deliveryGstLiable: "GOKESARI_S95", deliveryGstRateBp: 1800, deliveryGstPaise: 2_100 - Math.round((2_100 * 10_000) / 11_800) });

    const nov1 = await rerecord(order.id, new Date("2026-11-01T00:05:00+05:30"));
    expect(nov1).toMatchObject({ deliveryGstLiable: "GOKESARI_S95", deliveryGstRateBp: 500, deliveryGstPaise: 100 });

    // The delivery_9_5 flag off: nothing is charged under s.9(5).
    await flag("delivery_9_5", false);
    expect(await rerecord(order.id, new Date("2026-11-01T00:05:00+05:30"))).toMatchObject({ deliveryGstLiable: "NONE", deliveryGstPaise: 0 });
  });

  it("a GST-registered delivery partner pays the GST on their own service", async () => {
    await flag("billing_v2", true);
    await flag("delivery_9_5", true);
    const { milkSp } = await gstShop();
    const { order } = await deliveredOrder(admin, [[milkSp.id, 1]]);
    await db.update(orders).set({ deliveryFeePaise: 2_100 }).where(eq(orders.id, order.id));
    const rider = await createUser({ role: "DELIVERY_PARTNER" });
    const partner = await createDeliveryPartner(rider.id);
    await db.update(deliveryPartners).set({ gstRegistered: true, gstin: "27ABCDE1234F1Z5" }).where(eq(deliveryPartners.id, partner.id));
    await db.execute(sql`INSERT INTO delivery_orders (order_id, delivery_partner_id, status) VALUES (${order.id}, ${partner.id}, 'DELIVERED')`);
    expect(await rerecord(order.id)).toMatchObject({ deliveryGstLiable: "RIDER", deliveryGstPaise: 0 });
  });
});
