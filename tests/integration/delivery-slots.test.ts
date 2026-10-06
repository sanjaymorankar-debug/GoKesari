/**
 * F5 — delivery slot capacity. With the rule on, each window's current slot
 * takes at most N orders for a shop (shop limit → area limit → default);
 * full windows are not offered and simultaneous bookings never overbook.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { orders, platformSettings } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { getFeasibleDeliveryWindows } from "@/server/services/delivery-feasibility";
import { getSlotAvailability, slotKeyFor, upsertSlotCapacity } from "@/server/services/delivery-slots";
import { checkout } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

let adminId = "";

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(eq(platformSettings.key, "deliverySlots"));
  clearRuleCache();
  adminId = (await createUser({ role: "ADMIN" })).id;
});

async function enableSlots(defaults: { express?: number | null; standard?: number | null; scheduled?: number | null } = {}) {
  await setRule(
    "deliverySlots",
    {
      enabled: true,
      defaultExpressPerHour: defaults.express ?? null,
      defaultStandardPerHour: defaults.standard ?? null,
      defaultScheduledPerDay: defaults.scheduled ?? null,
    },
    { id: adminId, role: "ADMIN" },
  );
}

async function shopWithMilk() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { name: "Dairy One" });
  const sp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 7000, onlineStock: 50 });
  return { shop, sp };
}

async function customerWithCart(spId: string) {
  const { user } = await createUserWithWallet({ balancePaise: 500_000 });
  await addToCart(user.id, spId, 1);
  return user;
}

async function place(userId: string, requestId: string) {
  return checkout({ userId, addressId: await deliveryAddressId(userId), requestId, deliveryWindows: {} });
}

describe("delivery slot capacity", () => {
  it("is off by default: no slot key, no limit", async () => {
    const { shop, sp } = await shopWithMilk();
    await upsertSlotCapacity({ shopId: shop.id, expressPerHour: 0, standardPerHour: 0, scheduledPerDay: 0 }, adminId);
    const a = await customerWithCart(sp.id);
    const { orders: placed } = await place(a.id, "off-1");
    expect(placed[0].deliverySlotKey).toBeNull();
    expect((await getFeasibleDeliveryWindows(shop.id)).full).toBeUndefined();
  });

  it("books into the slot, shows it full, refuses the next order, and frees the place on cancel", async () => {
    const { shop, sp } = await shopWithMilk();
    await enableSlots();
    await upsertSlotCapacity({ shopId: shop.id, expressPerHour: null, standardPerHour: null, scheduledPerDay: 1 }, adminId);

    const a = await customerWithCart(sp.id);
    const { orders: first } = await place(a.id, "slot-a");
    // No rider is online, so only scheduled delivery is offered.
    expect(first[0].deliveryWindow).toBe("SCHEDULED");
    expect(first[0].deliverySlotKey).toBe(slotKeyFor("SCHEDULED"));

    const feasibility = await getFeasibleDeliveryWindows(shop.id);
    expect(feasibility.SCHEDULED).toBe(false);
    expect(feasibility.full?.SCHEDULED).toBe(true);

    const b = await customerWithCart(sp.id);
    await expect(place(b.id, "slot-b")).rejects.toMatchObject({ code: "CONFLICT" });

    await db.update(orders).set({ status: "CANCELLED" }).where(eq(orders.id, first[0].id));
    const { orders: second } = await place(b.id, "slot-b2");
    expect(second[0].deliverySlotKey).toBe(slotKeyFor("SCHEDULED"));
  });

  it("never overbooks when two customers book the last place at the same time", async () => {
    const { shop, sp } = await shopWithMilk();
    await enableSlots();
    await upsertSlotCapacity({ shopId: shop.id, expressPerHour: null, standardPerHour: null, scheduledPerDay: 1 }, adminId);
    const a = await customerWithCart(sp.id);
    const b = await customerWithCart(sp.id);
    const results = await Promise.allSettled([place(a.id, "race-a"), place(b.id, "race-b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await getSlotAvailability(shop.id)).slots.SCHEDULED.booked).toBe(1);
  });

  it("uses the shop limit over the area limit over the default", async () => {
    const { shop } = await shopWithMilk();
    await enableSlots({ scheduled: 50, express: 7 });
    await upsertSlotCapacity({ pincode: shop.pincode!, expressPerHour: 3, standardPerHour: null, scheduledPerDay: 9 }, adminId);
    await upsertSlotCapacity({ shopId: shop.id, expressPerHour: null, standardPerHour: null, scheduledPerDay: 2 }, adminId);
    const { slots } = await getSlotAvailability(shop.id);
    expect(slots.SCHEDULED.capacity).toBe(2);
    expect(slots.EXPRESS_30.capacity).toBe(3);
    expect(slots.STANDARD_60.capacity).toBeNull();
  });

  it("keys hours and days in IST", () => {
    const at = new Date("2026-10-05T20:45:00Z"); // 02:15 IST on the 6th
    expect(slotKeyFor("EXPRESS_30", at)).toBe("2026-10-06T02");
    expect(slotKeyFor("SCHEDULED", at)).toBe("2026-10-06");
  });

  it("validates admin input", async () => {
    await expect(upsertSlotCapacity({ pincode: "12", expressPerHour: 1, standardPerHour: null, scheduledPerDay: null }, adminId)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});
