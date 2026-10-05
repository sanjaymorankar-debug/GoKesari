/** F3 — busy riders are ranked after free ones (flag on) instead of excluded (flag off, original rule). */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { deliveryOrders, platformSettings } from "@/server/db/schema";
import { assignNearestPartner, getMyActiveDeliveryOrder, getMyOtherActiveDeliveries } from "@/server/services/delivery-assignment";
import { setRule } from "@/server/services/settings";
import { createDeliveryPartner, createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

const SHOP = { latitude: 18.5, longitude: 73.85 };
const kmNorth = (km: number) => SHOP.latitude + km / 111;
const dispatcher = { id: "", role: "ADMIN" as const };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(eq(platformSettings.key, "dispatch"));
});

async function setFallback(on: boolean, cap = 2) {
  const admin = await createUser({ role: "ADMIN" });
  dispatcher.id = admin.id;
  await setRule("dispatch", { busyRidersAsFallback: on, maxActiveDeliveriesPerRider: cap }, { id: admin.id, role: "ADMIN" });
}

async function readyOrder(shopId: string) {
  const customer = await createUser();
  return createOrder(customer.id, shopId, { status: "READY" });
}

async function scene() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { latitude: SHOP.latitude, longitude: SHOP.longitude });
  const nearUser = await createUser({ role: "DELIVERY_PARTNER" });
  const near = await createDeliveryPartner(nearUser.id, { isOnline: true, latitude: kmNorth(0.5), longitude: SHOP.longitude });
  // The near rider is already busy with one delivery.
  const first = await readyOrder(shop.id);
  await db.insert(deliveryOrders).values({ orderId: first.id, deliveryPartnerId: near.id, status: "PICKED_UP" });
  return { shop, near, nearUser };
}

describe("busy-rider fallback", () => {
  it("flag off (default): a busy rider is never offered another order", async () => {
    await setFallback(false);
    const { shop } = await scene();
    const order = await readyOrder(shop.id);
    await expect(assignNearestPartner(order.id, dispatcher)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("flag on: a free rider further away still wins over the nearer busy one", async () => {
    await setFallback(true);
    const { shop } = await scene();
    const farUser = await createUser({ role: "DELIVERY_PARTNER" });
    const far = await createDeliveryPartner(farUser.id, { isOnline: true, latitude: kmNorth(3), longitude: SHOP.longitude });
    const order = await readyOrder(shop.id);
    const offer = await assignNearestPartner(order.id, dispatcher);
    expect(offer.deliveryPartnerId).toBe(far.id);
  });

  it("flag on: the busy rider gets the offer when nobody else is available, up to the cap", async () => {
    await setFallback(true, 2);
    const { shop, near, nearUser } = await scene();
    const second = await readyOrder(shop.id);
    const offer = await assignNearestPartner(second.id, dispatcher);
    expect(offer.deliveryPartnerId).toBe(near.id);

    // The delivery already under way stays the rider's main card; the new offer is listed separately.
    expect((await getMyActiveDeliveryOrder(nearUser.id))?.status).toBe("PICKED_UP");
    const others = await getMyOtherActiveDeliveries(nearUser.id);
    expect(others.map((o) => o.id)).toEqual([offer.id]);

    // Holding 2 now — at the cap — so a third order finds nobody.
    const third = await readyOrder(shop.id);
    await expect(assignNearestPartner(third.id, dispatcher)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
