/**
 * F1 — lifecycle status models. The database trigger derives, checks and logs
 * shop / rider / subscription lifecycle on every write (migration 0042).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  deriveRiderLifecycle,
  deriveShopLifecycle,
  deriveSubscriptionLifecycle,
  TRANSITIONS,
} from "@/lib/status-models";
import { todayIn } from "@/lib/dates";
import { db } from "@/server/db";
import {
  deliveryOrders,
  deliveryPartners,
  platformSettings,
  shops,
  statusChanges,
  statusTransitionRules,
  subscriptions,
} from "@/server/db/schema";
import { goOffline, goOnline, suspendDeliveryPartner } from "@/server/services/delivery-partners";
import { approveShop, updateShop } from "@/server/services/shops";
import { suspendShopWithPolicy } from "@/server/services/shop-suspension";
import { cancelSubscription, createSubscription, pauseSubscription, resumeSubscription } from "@/server/services/subscriptions";
import { listStatusChanges } from "@/server/services/status-models";
import {
  createDeliveryPartner,
  createOrder,
  createShop,
  createStandardMilkSetup,
  createUser,
  resetDatabase,
} from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(eq(platformSettings.key, "statusModels"));
});

async function changesFor(entityId: string) {
  return db.select().from(statusChanges).where(eq(statusChanges.entityId, entityId)).orderBy(statusChanges.createdAt);
}

describe("transition rules", () => {
  it("database rules match lib/status-models.ts exactly", async () => {
    const rows = await db.select().from(statusTransitionRules);
    const fromDb = rows.map((r) => `${r.entityType}:${r.fromStatus}>${r.toStatus}`).sort();
    const fromTs = Object.entries(TRANSITIONS)
      .flatMap(([e, m]) => Object.entries(m).flatMap(([f, tos]) => tos.map((t) => `${e}:${f}>${t}`)))
      .sort();
    expect(fromDb).toEqual(fromTs);
  });
});

describe("shops", () => {
  it("derives and logs each lifecycle step with the actor", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const admin = await createUser({ role: "ADMIN" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", registrationFeePaise: 0 });
    await db.update(shops).set({ feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));
    expect(shop.lifecycleStatus).toBe("PENDING");

    const approved = await approveShop(shop.id, { classification: "KESARI" }, { id: admin.id, role: "ADMIN" });
    expect(approved.lifecycleStatus).toBe("ACTIVE");

    const paused = await updateShop(shop.id, { ordersPaused: true }, { id: owner.id, role: "SHOP_OWNER" });
    expect(paused.lifecycleStatus).toBe("PAUSED");

    await updateShop(shop.id, { ordersPaused: false }, { id: owner.id, role: "SHOP_OWNER" });
    await suspendShopWithPolicy(shop.id, { reason: "Licence lapsed" }, { id: admin.id, role: "ADMIN" });

    const log = await changesFor(shop.id);
    expect(log.map((c) => [c.fromStatus, c.toStatus])).toEqual([
      [null, "PENDING"],
      ["PENDING", "ACTIVE"],
      ["ACTIVE", "PAUSED"],
      ["PAUSED", "ACTIVE"],
      ["ACTIVE", "SUSPENDED"],
    ]);
    expect(log[1].actorId).toBe(admin.id);
    expect(log[2].actorId).toBe(owner.id);
    expect(log[4].actorId).toBe(admin.id);
    // The actor is a one-shot channel, never left on the row.
    const [row] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(row.statusActorId).toBeNull();
  });

  it("does not log edits that leave the lifecycle unchanged", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    await updateShop(shop.id, { description: "Fresh milk daily" }, { id: owner.id, role: "SHOP_OWNER" });
    expect(await changesFor(shop.id)).toHaveLength(1);
  });
});

describe("riders", () => {
  it("moves OFFLINE → AVAILABLE → BUSY → ON_DELIVERY → AVAILABLE with deliveries", async () => {
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    const partner = await createDeliveryPartner(riderUser.id, { isOnline: false });
    expect(partner.lifecycleStatus).toBe("OFFLINE");

    await goOnline(riderUser.id, 18.52, 73.85);
    const owner = await createUser({ role: "SHOP_OWNER" });
    const customer = await createUser();
    const shop = await createShop(owner.id);
    const order = await createOrder(customer.id, shop.id, { status: "READY" });
    const [delivery] = await db
      .insert(deliveryOrders)
      .values({ orderId: order.id, deliveryPartnerId: partner.id, status: "OFFERED" })
      .returning();
    const lifecycle = async () =>
      (await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, partner.id)))[0].lifecycleStatus;
    expect(await lifecycle()).toBe("BUSY");

    await db.update(deliveryOrders).set({ status: "PICKED_UP" }).where(eq(deliveryOrders.id, delivery.id));
    expect(await lifecycle()).toBe("ON_DELIVERY");

    await db.update(deliveryOrders).set({ status: "DELIVERED" }).where(eq(deliveryOrders.id, delivery.id));
    expect(await lifecycle()).toBe("AVAILABLE");

    await goOffline(riderUser.id);
    expect(await lifecycle()).toBe("OFFLINE");

    const log = await changesFor(partner.id);
    expect(log.map((c) => c.toStatus)).toEqual(["OFFLINE", "AVAILABLE", "BUSY", "ON_DELIVERY", "AVAILABLE", "OFFLINE"]);
    expect(log[1].actorId).toBe(riderUser.id);
  });

  it("is SUSPENDED when an admin suspends the rider", async () => {
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    const admin = await createUser({ role: "ADMIN" });
    const partner = await createDeliveryPartner(riderUser.id);
    await suspendDeliveryPartner(partner.id, "Repeated no-shows", { id: admin.id, role: "ADMIN" });
    const [row] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, partner.id));
    expect(row.lifecycleStatus).toBe("SUSPENDED");
    const [last] = (await changesFor(partner.id)).slice(-1);
    expect(last.actorId).toBe(admin.id);
  });
});

describe("subscriptions", () => {
  it("is ACTIVE, PAUSED during a pause window, back to ACTIVE, then CANCELLED (final)", async () => {
    const { customer, shopProduct } = await createStandardMilkSetup();
    const actor = { id: customer.id, role: "CUSTOMER" as const };
    const today = todayIn("Asia/Kolkata");
    const sub = await createSubscription({
      userId: customer.id,
      shopProductId: shopProduct.id,
      quantityMilli: 1000,
      frequency: "DAILY",
      startDate: today,
    });
    expect(sub.lifecycleStatus).toBe("ACTIVE");

    const paused = await pauseSubscription(sub.id, today, today, actor);
    expect(paused.lifecycleStatus).toBe("PAUSED");
    const resumed = await resumeSubscription(sub.id, actor);
    expect(resumed.lifecycleStatus).toBe("ACTIVE");
    const cancelled = await cancelSubscription(sub.id, "Moving away", actor);
    expect(cancelled.lifecycleStatus).toBe("CANCELLED");

    // CANCELLED is final: the database refuses to bring it back.
    await expect(
      db.update(subscriptions).set({ status: "ACTIVE" }).where(eq(subscriptions.id, sub.id)),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining("not allowed") } });
  });

  it("lets an admin switch enforcement off; the change is still logged as unenforced", async () => {
    const { customer, shopProduct } = await createStandardMilkSetup();
    const sub = await createSubscription({
      userId: customer.id,
      shopProductId: shopProduct.id,
      quantityMilli: 1000,
      frequency: "DAILY",
      startDate: todayIn("Asia/Kolkata"),
    });
    await cancelSubscription(sub.id, "x", { id: customer.id, role: "CUSTOMER" });
    await db.insert(platformSettings).values({ key: "statusModels", value: { enforceTransitions: false } });
    await db.update(subscriptions).set({ status: "ACTIVE" }).where(eq(subscriptions.id, sub.id));
    const [last] = (await changesFor(sub.id)).slice(-1);
    expect(last).toMatchObject({ fromStatus: "CANCELLED", toStatus: "ACTIVE", detail: expect.objectContaining({ unenforced: true }) });
  });
});

describe("SQL derivation matches the TypeScript model", () => {
  it("for every shop status × paused × deleted combination", async () => {
    for (const status of ["PENDING_APPROVAL", "APPROVED", "REJECTED", "SUSPENDED", "INACTIVE"] as const) {
      for (const paused of [false, true]) {
        for (const deleted of [null, new Date()]) {
          const [{ v }] = (await db.execute(
            sql`SELECT lifecycle_shop(${status}::shop_status, ${paused}, ${deleted ? deleted.toISOString() : null}::timestamptz)::text AS v`,
          )) as unknown as { v: string }[];
          expect(v).toBe(deriveShopLifecycle({ status, ordersPaused: paused, deletedAt: deleted }));
        }
      }
    }
  });

  it("for subscription pause windows", async () => {
    const today = (
      (await db.execute(sql`SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date)::text AS d`)) as unknown as { d: string }[]
    )[0].d;
    const cases: [string, string | null, string | null][] = [
      ["ACTIVE", null, null],
      ["ACTIVE", today, today],
      ["ACTIVE", "2099-01-01", "2099-01-02"],
      ["PAYMENT_PENDING", null, null],
      ["COMPLETED", null, null],
      ["CANCELLED", null, null],
    ];
    for (const [status, from, until] of cases) {
      const [{ v }] = (await db.execute(
        sql`SELECT lifecycle_subscription(${status}::subscription_status, ${from}::date, ${until}::date)::text AS v`,
      )) as unknown as { v: string }[];
      expect(v).toBe(deriveSubscriptionLifecycle({ status, pauseFrom: from, pauseUntil: until }, today));
    }
  });

  it("for rider states", () => {
    expect(deriveRiderLifecycle({ status: "APPROVED", isOnline: true, deletedAt: null, activeDelivery: null })).toBe("AVAILABLE");
    expect(deriveRiderLifecycle({ status: "UNDER_REVIEW", isOnline: false, deletedAt: null, activeDelivery: null })).toBe("ONBOARDING");
    expect(deriveRiderLifecycle({ status: "DEACTIVATED", isOnline: false, deletedAt: null, activeDelivery: null })).toBe("INACTIVE");
  });
});

describe("listStatusChanges", () => {
  it("filters by entity", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const rows = await listStatusChanges({ entityType: "SHOP", entityId: shop.id });
    expect(rows).toHaveLength(1);
    expect(await db.select().from(statusChanges).where(and(eq(statusChanges.entityType, "RIDER")))).toHaveLength(0);
  });
});
