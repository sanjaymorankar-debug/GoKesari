/**
 * GS-027 — the customer picks a date and time slot for a scheduled delivery.
 * Only future slots inside shop hours, after the cut-off and with places left
 * are offered; the place is re-checked under a lock at checkout.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { addDays, todayIn } from "@/lib/dates";
import { formatScheduledSlot, parseScheduledSlotKey, scheduledSlotKey } from "@/lib/scheduled-slots";
import { db } from "@/server/db";
import { orders, platformSettings, riderSearches, shops } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { dispatchReadyOrder } from "@/server/services/delivery-assignment";
import { getSlotAvailability, upsertSlotCapacity } from "@/server/services/delivery-slots";
import { checkout } from "@/server/services/orders";
import { listScheduledSlots } from "@/server/services/scheduled-slots";
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

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "08:00", close: "20:00" }));
let admin = { id: "", role: "ADMIN" as const };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(sql`${platformSettings.key} IN ('deliverySlots', 'scheduledSlots')`);
  clearRuleCache();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
});

async function enable(slots: Record<string, unknown> = {}) {
  await setRule("scheduledSlots", { enabled: true, ...slots }, admin);
}

async function shopWithMilk(hours = ALL_DAY) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { name: "Dairy One" });
  await db.update(shops).set({ openingHours: hours }).where(eq(shops.id, shop.id));
  const sp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 7000, onlineStock: 50 });
  return { shop, sp, owner };
}

async function customerWithCart(spId: string) {
  const { user } = await createUserWithWallet({ balancePaise: 500_000 });
  await addToCart(user.id, spId, 1);
  return user;
}

async function placeScheduled(userId: string, shopId: string, slotKey: string, requestId: string) {
  return checkout({
    userId,
    addressId: await deliveryAddressId(userId),
    requestId,
    deliveryWindows: { [shopId]: "SCHEDULED" },
    scheduledSlots: { [shopId]: slotKey },
  });
}

/** A Monday 09:15 IST, so the day's slots are predictable. */
const MONDAY_0915_IST = new Date("2026-10-05T03:45:00Z");

describe("slots offered", () => {
  it("is off by default", async () => {
    const { shop } = await shopWithMilk();
    expect(await listScheduledSlots(shop.id)).toEqual({ enabled: false, slots: [] });
  });

  it("offers future slots inside opening hours after the cut-off, for the next days", async () => {
    const { shop } = await shopWithMilk();
    await enable({ slotMinutes: 120, daysAhead: 2, cutoffMinutes: 60 });
    const { slots } = await listScheduledSlots(shop.id, MONDAY_0915_IST);
    const today = slots.filter((s) => s.date === "2026-10-05").map((s) => s.key);
    // 08–10 has started and 10–12 starts inside the 60-minute cut-off (09:15 + 60 > 10:00).
    expect(today).toEqual(["2026-10-05@12:00", "2026-10-05@14:00", "2026-10-05@16:00", "2026-10-05@18:00"]);
    expect(slots.filter((s) => s.date === "2026-10-06")).toHaveLength(6);
    expect(slots.some((s) => s.date === "2026-10-07")).toBe(false);
    expect(slots[0].label).toBe("Mon 5 Oct, 12–2 pm");
  });

  it("skips a day the shop is closed and uses the default day for a shop with no hours", async () => {
    const closedTuesday = ALL_DAY.map((h) => (h.day === 2 ? { ...h, closed: true } : h));
    const { shop } = await shopWithMilk(closedTuesday);
    await enable({ daysAhead: 3, defaultOpen: "10:00", defaultClose: "14:00" });
    const { slots } = await listScheduledSlots(shop.id, MONDAY_0915_IST);
    expect(slots.some((s) => s.date === "2026-10-06")).toBe(false);

    const { shop: noHours } = await shopWithMilk([]);
    const open = await listScheduledSlots(noHours.id, MONDAY_0915_IST);
    expect(open.slots.filter((s) => s.date === "2026-10-06").map((s) => s.key)).toEqual(["2026-10-06@10:00", "2026-10-06@12:00"]);
  });

  it("respects the shop's preparation time when it is longer than the cut-off", async () => {
    const { shop } = await shopWithMilk();
    await db.update(shops).set({ preparationTimeMinutes: 240 }).where(eq(shops.id, shop.id));
    await enable({ cutoffMinutes: 0, daysAhead: 1 });
    const { slots } = await listScheduledSlots(shop.id, MONDAY_0915_IST);
    expect(slots[0].key).toBe("2026-10-05@14:00"); // 09:15 + 4 h = 13:15
  });
});

describe("booking a slot at checkout", () => {
  it("stores the slot on the order and shows only slots with places left", async () => {
    const { shop, sp } = await shopWithMilk();
    await enable();
    await setRule("deliverySlots", { enabled: true }, admin);
    await upsertSlotCapacity(
      { shopId: shop.id, expressPerHour: null, standardPerHour: null, scheduledPerDay: null, scheduledPerSlot: 1 },
      admin.id,
    );
    const { slots } = await listScheduledSlots(shop.id);
    const slot = slots[0];

    const a = await customerWithCart(sp.id);
    const { orders: placed } = await placeScheduled(a.id, shop.id, slot.key, "slot-a");
    expect(placed[0]).toMatchObject({
      deliveryWindow: "SCHEDULED",
      deliverySlotKey: slot.key,
      deliveryDate: slot.date,
    });
    expect(placed[0].scheduledSlotStart?.toISOString()).toBe(slot.start);
    expect(placed[0].scheduledSlotEnd?.toISOString()).toBe(slot.end);
    expect(placed[0].promisedByAt?.toISOString()).toBe(slot.end);

    const after = await listScheduledSlots(shop.id);
    expect(after.slots.some((s) => s.key === slot.key)).toBe(false);

    const b = await customerWithCart(sp.id);
    await expect(placeScheduled(b.id, shop.id, slot.key, "slot-b")).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("has just filled up"),
    });
  });

  it("never lets two customers take the last place at the same time", async () => {
    const { shop, sp } = await shopWithMilk();
    await enable();
    await setRule("deliverySlots", { enabled: true, defaultScheduledPerSlot: 1 }, admin);
    const [slot] = (await listScheduledSlots(shop.id)).slots;
    const a = await customerWithCart(sp.id);
    const b = await customerWithCart(sp.id);
    const results = await Promise.allSettled([
      placeScheduled(a.id, shop.id, slot.key, "race-a"),
      placeScheduled(b.id, shop.id, slot.key, "race-b"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const booked = await db.select().from(orders).where(eq(orders.deliverySlotKey, slot.key));
    expect(booked).toHaveLength(1);
  });

  it("counts time-slot orders against the scheduled day limit", async () => {
    const { shop, sp } = await shopWithMilk();
    await enable();
    await setRule("deliverySlots", { enabled: true, defaultScheduledPerDay: 1 }, admin);
    const { slots } = await listScheduledSlots(shop.id);
    const today = todayIn("Asia/Kolkata");
    const daySlots = slots.filter((s) => s.date === slots[0].date);
    const a = await customerWithCart(sp.id);
    await placeScheduled(a.id, shop.id, daySlots[0].key, "day-a");
    const after = await listScheduledSlots(shop.id);
    expect(after.slots.some((s) => s.date === daySlots[0].date)).toBe(false);
    if (daySlots[0].date === today) {
      expect((await getSlotAvailability(shop.id)).slots.SCHEDULED.full).toBe(true);
    }
  });

  it("refuses a slot outside the shop's hours or inside the cut-off", async () => {
    const { shop, sp } = await shopWithMilk();
    await enable();
    const tomorrow = addDays(todayIn("Asia/Kolkata"), 1);
    const a = await customerWithCart(sp.id);
    await expect(placeScheduled(a.id, shop.id, `${tomorrow}@21:00`, "bad-hours")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const past = `${addDays(todayIn("Asia/Kolkata"), -1)}@10:00`;
    await expect(placeScheduled(a.id, shop.id, past, "bad-past")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("leaves 'deliver now' and scheduled-without-a-time exactly as before", async () => {
    const { shop, sp } = await shopWithMilk();
    await enable();
    const a = await customerWithCart(sp.id);
    const { orders: placed } = await checkout({
      userId: a.id,
      addressId: await deliveryAddressId(a.id),
      requestId: "no-slot",
      deliveryWindows: { [shop.id]: "SCHEDULED" },
    });
    expect(placed[0]).toMatchObject({ deliveryWindow: "SCHEDULED", scheduledSlotStart: null, deliveryDate: null, promisedByAt: null });
  });
});

describe("rider search waits for the slot", () => {
  it("does not look for a rider until shortly before the slot, unless the shop presses Find rider now", async () => {
    const { shop, sp, owner } = await shopWithMilk();
    await enable({ dispatchLeadMinutes: 45 });
    const { slots } = await listScheduledSlots(shop.id);
    const later = slots[slots.length - 1]; // well over 45 minutes away
    const a = await customerWithCart(sp.id);
    const { orders: placed } = await placeScheduled(a.id, shop.id, later.key, "dispatch");
    await db.update(orders).set({ status: "READY" }).where(eq(orders.id, placed[0].id));

    await dispatchReadyOrder(placed[0].id, { id: null, role: null }, "AUTO_READY");
    expect(await db.select().from(riderSearches).where(eq(riderSearches.orderId, placed[0].id))).toHaveLength(0);

    await dispatchReadyOrder(placed[0].id, { id: owner.id, role: "SHOP_OWNER" }, "SHOP_MANUAL");
    expect(await db.select().from(riderSearches).where(eq(riderSearches.orderId, placed[0].id))).toHaveLength(1);
  });
});

describe("slot helpers", () => {
  it("round-trips keys and formats IST labels", () => {
    expect(scheduledSlotKey("2026-10-07", 14 * 60)).toBe("2026-10-07@14:00");
    expect(parseScheduledSlotKey("2026-10-07@14:30")).toEqual({ date: "2026-10-07", startMinutes: 870 });
    expect(parseScheduledSlotKey("2026-10-07T14")).toBeNull();
    expect(formatScheduledSlot("2026-10-07T05:30:00Z", "2026-10-07T07:30:00Z")).toBe("Wed 7 Oct, 11 am–1 pm");
  });
});
