/**
 * Subscription engine (requirements §25–§39).
 *
 * The daily-milk use case drives the design:
 *   "2 L every day, but 3 L tomorrow, skip Sunday, pause 25–30 Aug."
 *
 * Schedule resolution is a **pure function** (`resolveDelivery`) so every rule
 * — pause windows, per-date overrides, skips, start/end bounds, weekly
 * frequency — is unit-testable without a database.
 *
 * Order generation is **idempotent by construction**: `subscription_orders` has
 * a UNIQUE(subscription_id, delivery_date) index, so a re-run of the daily job
 * (retry, overlapping cron, manual replay) cannot create a second delivery or a
 * second wallet deduction for the same day.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import {
  addDays,
  isWithin,
  isoWeekday,
  todayIn,
  type IsoDate,
} from "@/lib/dates";
import { AppError, conflict, notFound, validationFailed } from "@/lib/errors";
import { formatPaise, lineTotalPaise } from "@/lib/money";
import { getEnv } from "@/lib/env";
import { db, type DbClient } from "@/server/db";
import {
  addresses,
  orderItems,
  orderStatusHistory,
  orders,
  products,
  shopProducts,
  shops,
  subscriptionDailyOverrides,
  subscriptionEvents,
  subscriptionOrders,
  subscriptions,
  wallets,
  type Subscription,
  type SubscriptionDailyOverride,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { resolveAddressSociety } from "./societies";
import { consumeOnlineStock, isOnlinePurchasable } from "./catalogue";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { generateOrderNumber } from "./orders";
import { applyWalletMutation } from "./wallet";

/* ------------------------------------------------- pure schedule engine */

export interface ScheduleInput {
  status: Subscription["status"];
  frequency: "DAILY" | "WEEKLY";
  weekdays: number[];
  quantityMilli: number;
  startDate: IsoDate;
  endDate: IsoDate | null;
  pauseFrom: IsoDate | null;
  pauseUntil: IsoDate | null;
}

export type DeliveryResolution =
  | { delivers: true; quantityMilli: number; reason: "STANDARD" | "OVERRIDE" }
  | {
      delivers: false;
      reason:
        | "NOT_ACTIVE"
        | "BEFORE_START"
        | "AFTER_END"
        | "PAUSED"
        | "NOT_SCHEDULED_DAY"
        | "SKIPPED";
    };

/**
 * The single source of truth for "does this subscription deliver on this date,
 * and how much?".
 *
 * Rule order matters and is deliberate:
 *   1. Subscription must be live at all.
 *   2. Date must fall inside the subscription's window.
 *   3. A pause window suppresses everything.
 *   4. The frequency must actually schedule this weekday.
 *   5. Only then may a per-date override adjust or skip it.
 *
 * Step 5 last means an override never *creates* a delivery on a day the
 * schedule doesn't cover — it only modifies one that already exists.
 */
export function resolveDelivery(
  subscription: ScheduleInput,
  date: IsoDate,
  override?: Pick<SubscriptionDailyOverride, "type" | "quantityMilli"> | null,
): DeliveryResolution {
  if (subscription.status !== "ACTIVE" && subscription.status !== "PAYMENT_PENDING") {
    return { delivers: false, reason: "NOT_ACTIVE" };
  }
  if (date < subscription.startDate) {
    return { delivers: false, reason: "BEFORE_START" };
  }
  if (subscription.endDate && date > subscription.endDate) {
    return { delivers: false, reason: "AFTER_END" };
  }
  if (
    subscription.pauseFrom &&
    subscription.pauseUntil &&
    isWithin(date, subscription.pauseFrom, subscription.pauseUntil)
  ) {
    return { delivers: false, reason: "PAUSED" };
  }
  if (subscription.frequency === "WEEKLY") {
    const weekday = isoWeekday(date);
    if (!subscription.weekdays.includes(weekday)) {
      return { delivers: false, reason: "NOT_SCHEDULED_DAY" };
    }
  }

  if (override) {
    if (override.type === "SKIP") {
      return { delivers: false, reason: "SKIPPED" };
    }
    if (override.type === "QUANTITY" && override.quantityMilli != null) {
      return {
        delivers: true,
        quantityMilli: override.quantityMilli,
        reason: "OVERRIDE",
      };
    }
  }

  return {
    delivers: true,
    quantityMilli: subscription.quantityMilli,
    reason: "STANDARD",
  };
}

/** Next date on or after `from` that the subscription delivers. */
export function nextDeliveryDate(
  subscription: ScheduleInput,
  from: IsoDate,
  overridesByDate: Map<IsoDate, SubscriptionDailyOverride> = new Map(),
  lookaheadDays = 60,
): IsoDate | null {
  for (let i = 0; i < lookaheadDays; i += 1) {
    const date = addDays(from, i);
    const result = resolveDelivery(subscription, date, overridesByDate.get(date));
    if (result.delivers) return date;
    // Nothing further can deliver once we are past the end date.
    if (result.reason === "AFTER_END") return null;
  }
  return null;
}

/* ------------------------------------------------------------- create */

export interface CreateSubscriptionInput {
  userId: string;
  shopProductId: string;
  quantityMilli: number;
  frequency?: "DAILY" | "WEEKLY";
  weekdays?: number[];
  startDate: IsoDate;
  endDate?: IsoDate | null;
  addressId?: string | null;
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<Subscription> {
  if (!Number.isInteger(input.quantityMilli) || input.quantityMilli <= 0) {
    throw validationFailed("Quantity must be a positive amount.");
  }
  const frequency = input.frequency ?? "DAILY";
  if (frequency === "WEEKLY" && (input.weekdays ?? []).length === 0) {
    throw validationFailed("Choose at least one delivery day of the week.");
  }

  const [row] = await db
    .select({ sp: shopProducts, product: products, shopStatus: shops.status })
    .from(shopProducts)
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .innerJoin(shops, eq(shopProducts.shopId, shops.id))
    .where(eq(shopProducts.id, input.shopProductId))
    .limit(1);
  if (!row) throw notFound("Product");

  if (!row.product.subscribable) {
    throw validationFailed("This product is not available for subscription.");
  }
  // A subscription is a promise of repeated online purchases, so the product
  // must be online-purchasable at the moment it is set up.
  const unitsPerDelivery = Math.ceil(
    input.quantityMilli / row.product.unitSizeMilli,
  );
  if (
    !isOnlinePurchasable(
      {
        shopStatus: row.shopStatus,
        isActive: row.sp.isActive,
        isAvailable: row.sp.isAvailable,
        onlineSaleEnabled: row.sp.onlineSaleEnabled,
        onlinePricePaise: row.sp.onlinePricePaise,
        trackInventory: false, // stock is checked per delivery, not at signup
        onlineStock: 0,
      },
      unitsPerDelivery,
    )
  ) {
    throw conflict("This product cannot be subscribed to online right now.");
  }

  const [subscription] = await db
    .insert(subscriptions)
    .values({
      userId: input.userId,
      shopId: row.sp.shopId,
      shopProductId: input.shopProductId,
      addressId: input.addressId ?? null,
      quantityMilli: input.quantityMilli,
      frequency,
      weekdays: input.weekdays ?? [],
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      status: "ACTIVE",
    })
    .returning();

  const next = nextDeliveryDate(toScheduleInput(subscription), input.startDate);
  const [withNext] = await db
    .update(subscriptions)
    .set({ nextDeliveryDate: next })
    .where(eq(subscriptions.id, subscription.id))
    .returning();

  await recordAudit({
    actorId: input.userId,
    action: AUDIT_ACTIONS.SUBSCRIPTION_CREATED,
    entityType: "subscription",
    entityId: subscription.id,
    newValue: {
      quantityMilli: input.quantityMilli,
      frequency,
      startDate: input.startDate,
    },
  });

  await notify({
    userId: input.userId,
    type: NOTIFICATION_TYPES.SUBSCRIPTION_CREATED,
    title: "Subscription created",
    body: `Your ${row.product.name} subscription starts on ${input.startDate}.`,
    actionUrl: `/subscriptions/${subscription.id}`,
  });

  return withNext;
}

/* ------------------------------------------------------- modification */

/** Permanent change to the standing subscription (§32). */
export async function updateSubscription(
  subscriptionId: string,
  patch: {
    quantityMilli?: number;
    shopProductId?: string;
    frequency?: "DAILY" | "WEEKLY";
    weekdays?: number[];
    addressId?: string | null;
    endDate?: IsoDate | null;
    /** Change takes effect from this date; earlier generated orders are untouched. */
    effectiveFrom?: IsoDate;
  },
  actor: { id: string; role: UserRole },
): Promise<Subscription> {
  const current = await getSubscription(subscriptionId);
  if (!current) throw notFound("Subscription");

  if (
    patch.quantityMilli !== undefined &&
    (!Number.isInteger(patch.quantityMilli) || patch.quantityMilli <= 0)
  ) {
    throw validationFailed("Quantity must be a positive amount.");
  }

  const [updated] = await db
    .update(subscriptions)
    .set({
      ...(patch.quantityMilli !== undefined
        ? { quantityMilli: patch.quantityMilli }
        : {}),
      ...(patch.shopProductId ? { shopProductId: patch.shopProductId } : {}),
      ...(patch.frequency ? { frequency: patch.frequency } : {}),
      ...(patch.weekdays ? { weekdays: patch.weekdays } : {}),
      ...(patch.addressId !== undefined ? { addressId: patch.addressId } : {}),
      ...(patch.endDate !== undefined ? { endDate: patch.endDate } : {}),
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, subscriptionId))
    .returning();

  await refreshNextDeliveryDate(subscriptionId);

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SUBSCRIPTION_MODIFIED,
    entityType: "subscription",
    entityId: subscriptionId,
    previousValue: {
      quantityMilli: current.quantityMilli,
      frequency: current.frequency,
    },
    newValue: patch,
  });

  return updated;
}

/**
 * Sets tomorrow's (or any future date's) quantity without touching the standing
 * subscription (§28). The schedule reverts automatically the next day because
 * the override row is scoped to exactly one date.
 */
export async function setDailyOverride(
  subscriptionId: string,
  date: IsoDate,
  quantityMilli: number,
  actor: { id: string; role: UserRole },
): Promise<SubscriptionDailyOverride> {
  if (!Number.isInteger(quantityMilli) || quantityMilli <= 0) {
    throw validationFailed("Quantity must be a positive amount.");
  }
  await assertDateIsModifiable(subscriptionId, date);

  const [override] = await db
    .insert(subscriptionDailyOverrides)
    .values({
      subscriptionId,
      deliveryDate: date,
      type: "QUANTITY",
      quantityMilli,
      createdBy: actor.id,
    })
    .onConflictDoUpdate({
      target: [
        subscriptionDailyOverrides.subscriptionId,
        subscriptionDailyOverrides.deliveryDate,
      ],
      set: { type: "QUANTITY", quantityMilli, updatedAt: new Date() },
    })
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SUBSCRIPTION_OVERRIDE_SET,
    entityType: "subscription",
    entityId: subscriptionId,
    newValue: { date, quantityMilli },
  });
  return override;
}

/** Skips one delivery — no order, no deduction (§30). */
export async function skipDate(
  subscriptionId: string,
  date: IsoDate,
  actor: { id: string; role: UserRole },
): Promise<SubscriptionDailyOverride> {
  const current = await loadLiveSubscription(subscriptionId);
  await assertDateIsModifiable(subscriptionId, date);
  await recordSubscriptionEvent({
    subscriptionId,
    action: "SKIPPED",
    fromStatus: current.status,
    toStatus: current.status,
    note: date,
    actorId: actor.id,
  });

  const [override] = await db
    .insert(subscriptionDailyOverrides)
    .values({
      subscriptionId,
      deliveryDate: date,
      type: "SKIP",
      quantityMilli: null,
      createdBy: actor.id,
    })
    .onConflictDoUpdate({
      target: [
        subscriptionDailyOverrides.subscriptionId,
        subscriptionDailyOverrides.deliveryDate,
      ],
      set: { type: "SKIP", quantityMilli: null, updatedAt: new Date() },
    })
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SUBSCRIPTION_OVERRIDE_SET,
    entityType: "subscription",
    entityId: subscriptionId,
    newValue: { date, skipped: true },
  });

  await notify({
    userId: (await getSubscription(subscriptionId))!.userId,
    type: NOTIFICATION_TYPES.SUBSCRIPTION_SKIPPED,
    title: "Delivery skipped",
    body: `Your delivery on ${date} has been skipped. No amount will be deducted.`,
    actionUrl: `/subscriptions/${subscriptionId}`,
  });
  return override;
}

/** Removes an override, restoring the standing quantity for that date. */
export async function clearOverride(
  subscriptionId: string,
  date: IsoDate,
): Promise<void> {
  await assertDateIsModifiable(subscriptionId, date);
  await db
    .delete(subscriptionDailyOverrides)
    .where(
      and(
        eq(subscriptionDailyOverrides.subscriptionId, subscriptionId),
        eq(subscriptionDailyOverrides.deliveryDate, date),
      ),
    );
}

/* ------------------------------------------------ lifecycle guards & history (Phase 2)
 * Allowed transitions (brief §9):
 *   ACTIVE ⇄ paused window (pause / resume)     ACTIVE → date skipped → ACTIVE
 *   ACTIVE / PAYMENT_PENDING → CANCELLED         CANCELLED / COMPLETED → nothing
 * Every lifecycle action is written to subscription_events (history).
 */

const FINAL_STATUSES = ["CANCELLED", "COMPLETED"] as const;

async function loadLiveSubscription(subscriptionId: string): Promise<Subscription> {
  const subscription = await db.query.subscriptions.findFirst({ where: eq(subscriptions.id, subscriptionId) });
  if (!subscription) throw notFound("Subscription");
  if ((FINAL_STATUSES as readonly string[]).includes(subscription.status)) {
    throw conflict(`This subscription is ${subscription.status.toLowerCase()} and can no longer be changed.`);
  }
  return subscription;
}

export async function recordSubscriptionEvent(
  input: {
    subscriptionId: string;
    action: string;
    fromStatus?: Subscription["status"] | null;
    toStatus?: Subscription["status"] | null;
    note?: string | null;
    actorId?: string | null;
  },
  client: DbClient = db,
): Promise<void> {
  try {
    await client.insert(subscriptionEvents).values({
      subscriptionId: input.subscriptionId,
      action: input.action,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      note: input.note ?? null,
      actorId: input.actorId ?? null,
    });
  } catch (error) {
    // History must never break the action it records.
    console.error("[subscriptions] failed to record event", input.action, error);
  }
}

export async function listSubscriptionEvents(subscriptionId: string) {
  return db
    .select()
    .from(subscriptionEvents)
    .where(eq(subscriptionEvents.subscriptionId, subscriptionId))
    .orderBy(desc(subscriptionEvents.createdAt))
    .limit(100);
}

export async function pauseSubscription(
  subscriptionId: string,
  from: IsoDate,
  until: IsoDate,
  actor: { id: string; role: UserRole },
): Promise<Subscription> {
  if (until < from) {
    throw validationFailed("The pause end date must be on or after the start date.");
  }
  const current = await loadLiveSubscription(subscriptionId);
  const [updated] = await db
    .update(subscriptions)
    .set({ pauseFrom: from, pauseUntil: until, updatedAt: new Date() })
    .where(eq(subscriptions.id, subscriptionId))
    .returning();
  if (!updated) throw notFound("Subscription");

  await refreshNextDeliveryDate(subscriptionId);
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SUBSCRIPTION_PAUSED,
    entityType: "subscription",
    entityId: subscriptionId,
    newValue: { from, until },
  });
  await recordSubscriptionEvent({
    subscriptionId,
    action: "PAUSED",
    fromStatus: current.status,
    toStatus: updated.status,
    note: `${from} to ${until}`,
    actorId: actor.id,
  });
  await notify({
    userId: updated.userId,
    type: NOTIFICATION_TYPES.SUBSCRIPTION_PAUSED,
    title: "Subscription paused",
    body: `Deliveries are paused from ${from} to ${until}. Nothing will be deducted during this period.`,
    actionUrl: `/subscriptions/${subscriptionId}`,
  });
  return updated;
}

export async function resumeSubscription(
  subscriptionId: string,
  actor: { id: string; role: UserRole },
): Promise<Subscription> {
  // A cancelled / completed subscription is never revived by "resume".
  const current = await loadLiveSubscription(subscriptionId);
  const [updated] = await db
    .update(subscriptions)
    .set({
      pauseFrom: null,
      pauseUntil: null,
      status: "ACTIVE",
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, subscriptionId))
    .returning();
  if (!updated) throw notFound("Subscription");

  await refreshNextDeliveryDate(subscriptionId);
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SUBSCRIPTION_RESUMED,
    entityType: "subscription",
    entityId: subscriptionId,
  });
  await recordSubscriptionEvent({
    subscriptionId,
    action: "RESUMED",
    fromStatus: current.status,
    toStatus: updated.status,
    actorId: actor.id,
  });
  await notify({
    userId: updated.userId,
    type: NOTIFICATION_TYPES.SUBSCRIPTION_RESUMED,
    title: "Subscription resumed",
    body: updated.nextDeliveryDate
      ? `Deliveries resume on ${updated.nextDeliveryDate}.`
      : "Your subscription is active again.",
    actionUrl: `/subscriptions/${subscriptionId}`,
  });
  return updated;
}

export async function cancelSubscription(
  subscriptionId: string,
  reason: string,
  actor: { id: string; role: UserRole },
): Promise<Subscription> {
  const current = await loadLiveSubscription(subscriptionId);
  const [updated] = await db
    .update(subscriptions)
    .set({
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancellationReason: reason,
      nextDeliveryDate: null,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, subscriptionId))
    .returning();
  if (!updated) throw notFound("Subscription");

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SUBSCRIPTION_CANCELLED,
    entityType: "subscription",
    entityId: subscriptionId,
    newValue: { reason },
  });
  await recordSubscriptionEvent({
    subscriptionId,
    action: "CANCELLED",
    fromStatus: current.status,
    toStatus: "CANCELLED",
    note: reason,
    actorId: actor.id,
  });
  await notify({
    userId: updated.userId,
    type: NOTIFICATION_TYPES.SUBSCRIPTION_CANCELLED,
    title: "Subscription cancelled",
    body: "No further deliveries will be scheduled or charged.",
    actionUrl: `/subscriptions/${subscriptionId}`,
  });
  return updated;
}

/* ---------------------------------------------------------- retrieval */

export async function getSubscription(
  subscriptionId: string,
  client: DbClient = db,
): Promise<Subscription | undefined> {
  return client.query.subscriptions.findFirst({
    where: eq(subscriptions.id, subscriptionId),
  });
}

export interface SubscriptionDetail extends Subscription {
  productName: string;
  unit: string;
  unitSizeMilli: number;
  shopName: string;
  shopSlug: string;
  currentUnitPricePaise: number | null;
}

export async function listSubscriptionsForUser(
  userId: string,
): Promise<SubscriptionDetail[]> {
  const rows = await db
    .select({
      sub: subscriptions,
      product: products,
      sp: shopProducts,
      shop: shops,
    })
    .from(subscriptions)
    .innerJoin(shopProducts, eq(subscriptions.shopProductId, shopProducts.id))
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .innerJoin(shops, eq(subscriptions.shopId, shops.id))
    .where(eq(subscriptions.userId, userId))
    .orderBy(asc(subscriptions.createdAt));

  return rows.map((r) => ({
    ...r.sub,
    productName: r.product.name,
    unit: r.product.unit,
    unitSizeMilli: r.product.unitSizeMilli,
    shopName: r.shop.name,
    shopSlug: r.shop.slug,
    currentUnitPricePaise: r.sp.onlinePricePaise,
  }));
}

export async function getSubscriptionDetail(
  subscriptionId: string,
): Promise<SubscriptionDetail | undefined> {
  const [row] = await db
    .select({
      sub: subscriptions,
      product: products,
      sp: shopProducts,
      shop: shops,
    })
    .from(subscriptions)
    .innerJoin(shopProducts, eq(subscriptions.shopProductId, shopProducts.id))
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .innerJoin(shops, eq(subscriptions.shopId, shops.id))
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);
  if (!row) return undefined;

  return {
    ...row.sub,
    productName: row.product.name,
    unit: row.product.unit,
    unitSizeMilli: row.product.unitSizeMilli,
    shopName: row.shop.name,
    shopSlug: row.shop.slug,
    currentUnitPricePaise: row.sp.onlinePricePaise,
  };
}

export async function getOverrides(
  subscriptionId: string,
  fromDate?: IsoDate,
): Promise<SubscriptionDailyOverride[]> {
  return db
    .select()
    .from(subscriptionDailyOverrides)
    .where(
      and(
        eq(subscriptionDailyOverrides.subscriptionId, subscriptionId),
        fromDate
          ? gte(subscriptionDailyOverrides.deliveryDate, fromDate)
          : undefined,
      ),
    )
    .orderBy(asc(subscriptionDailyOverrides.deliveryDate));
}

/* ------------------------------------------------------------ calendar */

export interface CalendarDay {
  date: IsoDate;
  delivers: boolean;
  quantityMilli: number;
  reason: DeliveryResolution["reason"];
  isOverridden: boolean;
  estimatedCostPaise: number;
  /** Set once the day has actually been generated. */
  generatedStatus: string | null;
}

/** Upcoming delivery calendar with overrides applied (§36). */
export async function getCalendar(
  subscriptionId: string,
  days = 30,
  startFrom?: IsoDate,
): Promise<CalendarDay[]> {
  const detail = await getSubscriptionDetail(subscriptionId);
  if (!detail) throw notFound("Subscription");

  const start = startFrom ?? todayIn(getEnv().APP_TIMEZONE);
  const overrides = await getOverrides(subscriptionId, start);
  const overrideMap = new Map(overrides.map((o) => [o.deliveryDate, o]));

  const generated = await db
    .select({
      deliveryDate: subscriptionOrders.deliveryDate,
      status: subscriptionOrders.status,
    })
    .from(subscriptionOrders)
    .where(
      and(
        eq(subscriptionOrders.subscriptionId, subscriptionId),
        gte(subscriptionOrders.deliveryDate, start),
      ),
    );
  const generatedMap = new Map(generated.map((g) => [g.deliveryDate, g.status]));

  const schedule = toScheduleInput(detail);
  const price = detail.currentUnitPricePaise ?? 0;

  return Array.from({ length: days }, (_, i) => {
    const date = addDays(start, i);
    const override = overrideMap.get(date);
    const result = resolveDelivery(schedule, date, override);
    const quantityMilli = result.delivers ? result.quantityMilli : 0;

    return {
      date,
      delivers: result.delivers,
      quantityMilli,
      reason: result.reason,
      isOverridden: Boolean(override),
      estimatedCostPaise:
        result.delivers && price > 0 ? lineTotalPaise(price, quantityMilli) : 0,
      generatedStatus: generatedMap.get(date) ?? null,
    };
  });
}

/* ------------------------------------------------- cost & forecasting */

export interface CostPreview {
  unitPricePaise: number;
  quantityMilli: number;
  dailyCostPaise: number;
  sevenDayCostPaise: number;
  thirtyDayCostPaise: number;
  deliveryDaysIn30: number;
}

/**
 * Estimate shown before activation (§35). Uses the *current* price and is
 * explicitly an estimate — actual deductions follow the price on each delivery
 * day (§34).
 */
export async function getCostPreview(
  shopProductId: string,
  quantityMilli: number,
  frequency: "DAILY" | "WEEKLY" = "DAILY",
  weekdays: number[] = [],
): Promise<CostPreview> {
  const sp = await db.query.shopProducts.findFirst({
    where: eq(shopProducts.id, shopProductId),
  });
  if (!sp) throw notFound("Product");
  const price = sp.onlinePricePaise ?? 0;

  const perDelivery = price > 0 ? lineTotalPaise(price, quantityMilli) : 0;
  const deliveriesPerWeek = frequency === "DAILY" ? 7 : weekdays.length;
  const deliveryDaysIn30 = Math.round((deliveriesPerWeek / 7) * 30);

  return {
    unitPricePaise: price,
    quantityMilli,
    dailyCostPaise: perDelivery,
    sevenDayCostPaise: perDelivery * deliveriesPerWeek,
    thirtyDayCostPaise: perDelivery * deliveryDaysIn30,
    deliveryDaysIn30,
  };
}

export interface WalletForecast {
  walletBalancePaise: number;
  horizonDays: number;
  upcomingCostPaise: number;
  shortfallPaise: number;
  sufficient: boolean;
  /** Rounded up to a sensible top-up amount. */
  recommendedTopUpPaise: number;
  perSubscription: {
    subscriptionId: string;
    productName: string;
    costPaise: number;
  }[];
}

/**
 * Projects wallet balance against upcoming subscription cost (§37).
 * Advisory only — it never charges anything.
 */
export async function getWalletForecast(
  userId: string,
  horizonDays = 15,
): Promise<WalletForecast> {
  const wallet = await db.query.wallets.findFirst({
    where: eq(wallets.userId, userId),
  });
  const balance = wallet?.balancePaise ?? 0;

  const subs = await listSubscriptionsForUser(userId);
  const active = subs.filter(
    (s) => s.status === "ACTIVE" || s.status === "PAYMENT_PENDING",
  );

  const perSubscription: WalletForecast["perSubscription"] = [];
  let total = 0;

  for (const sub of active) {
    const calendar = await getCalendar(sub.id, horizonDays);
    const cost = calendar.reduce((sum, day) => sum + day.estimatedCostPaise, 0);
    total += cost;
    perSubscription.push({
      subscriptionId: sub.id,
      productName: sub.productName,
      costPaise: cost,
    });
  }

  const shortfall = Math.max(0, total - balance);
  return {
    walletBalancePaise: balance,
    horizonDays,
    upcomingCostPaise: total,
    shortfallPaise: shortfall,
    sufficient: shortfall === 0,
    // Round the suggestion up to the next ₹100 so it clears the gap.
    recommendedTopUpPaise:
      shortfall === 0 ? 0 : Math.ceil(shortfall / 10_000) * 10_000,
    perSubscription,
  };
}

/* --------------------------------------------- daily generation engine */

export interface GenerationResult {
  date: IsoDate;
  generated: number;
  skipped: number;
  alreadyExisted: number;
  walletFailures: number;
  unavailable: number;
  errors: { subscriptionId: string; message: string }[];
}

/**
 * Generates one delivery per due subscription for `date` (§33).
 *
 * Idempotent: the UNIQUE(subscription_id, delivery_date) index means a second
 * run is a no-op. Each subscription is processed independently so one failure
 * cannot abort the batch.
 */
export async function generateDailyOrders(
  date?: IsoDate,
  options: { subscriptionIds?: string[] } = {},
): Promise<GenerationResult> {
  const env = getEnv();
  const targetDate = date ?? todayIn(env.APP_TIMEZONE);

  const result: GenerationResult = {
    date: targetDate,
    generated: 0,
    skipped: 0,
    alreadyExisted: 0,
    walletFailures: 0,
    unavailable: 0,
    errors: [],
  };

  const due = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        inArray(subscriptions.status, ["ACTIVE", "PAYMENT_PENDING"]),
        lte(subscriptions.startDate, targetDate),
        or(
          isNull(subscriptions.endDate),
          gte(subscriptions.endDate, targetDate),
        ),
        options.subscriptionIds
          ? inArray(subscriptions.id, options.subscriptionIds)
          : undefined,
      ),
    );

  for (const subscription of due) {
    try {
      const outcome = await generateOneDelivery(subscription, targetDate);
      switch (outcome) {
        case "GENERATED":
          result.generated += 1;
          break;
        case "SKIPPED":
          result.skipped += 1;
          break;
        case "ALREADY_EXISTS":
          result.alreadyExisted += 1;
          break;
        case "WALLET_INSUFFICIENT":
          result.walletFailures += 1;
          break;
        case "UNAVAILABLE":
          result.unavailable += 1;
          break;
      }
    } catch (error) {
      result.errors.push({
        subscriptionId: subscription.id,
        message: error instanceof Error ? error.message : String(error),
      });
      console.error(
        `[subscriptions] generation failed for ${subscription.id}`,
        error,
      );
    }
  }

  return result;
}

type DeliveryOutcome =
  | "GENERATED"
  | "SKIPPED"
  | "ALREADY_EXISTS"
  | "WALLET_INSUFFICIENT"
  | "UNAVAILABLE";

async function generateOneDelivery(
  subscription: Subscription,
  date: IsoDate,
): Promise<DeliveryOutcome> {
  // Cheap pre-check; the unique index is the real guarantee.
  const existing = await db.query.subscriptionOrders.findFirst({
    where: and(
      eq(subscriptionOrders.subscriptionId, subscription.id),
      eq(subscriptionOrders.deliveryDate, date),
    ),
  });
  if (existing) return "ALREADY_EXISTS";

  const override = await db.query.subscriptionDailyOverrides.findFirst({
    where: and(
      eq(subscriptionDailyOverrides.subscriptionId, subscription.id),
      eq(subscriptionDailyOverrides.deliveryDate, date),
    ),
  });

  const resolution = resolveDelivery(
    toScheduleInput(subscription),
    date,
    override,
  );
  if (!resolution.delivers) {
    await refreshNextDeliveryDate(subscription.id);
    return "SKIPPED";
  }

  const [row] = await db
    .select({ sp: shopProducts, product: products, shop: shops })
    .from(shopProducts)
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .innerJoin(shops, eq(shopProducts.shopId, shops.id))
    .where(eq(shopProducts.id, subscription.shopProductId))
    .limit(1);
  if (!row) return "UNAVAILABLE";

  const unitsNeeded = Math.ceil(
    resolution.quantityMilli / row.product.unitSizeMilli,
  );
  const purchasable = isOnlinePurchasable(
    {
      shopStatus: row.shop.status,
      isActive: row.sp.isActive,
      isAvailable: row.sp.isAvailable,
      onlineSaleEnabled: row.sp.onlineSaleEnabled,
      onlinePricePaise: row.sp.onlinePricePaise,
      trackInventory: row.sp.trackInventory,
      onlineStock: row.sp.onlineStock,
    },
    unitsNeeded,
  );
  if (!purchasable) {
    await notify({
      userId: subscription.userId,
      type: NOTIFICATION_TYPES.SUBSCRIPTION_PAYMENT_FAILED,
      title: "Delivery unavailable",
      body: `${row.product.name} could not be delivered on ${date} because it is unavailable at ${row.shop.name}.`,
      actionUrl: `/subscriptions/${subscription.id}`,
      dedupeKey: `unavailable:${subscription.id}:${date}`,
    });
    return "UNAVAILABLE";
  }

  // Price is read now, at generation time, and snapshotted into the order —
  // this is what makes a later price change affect only future orders (§34).
  const unitPricePaise = row.sp.onlinePricePaise!;
  const totalPaise = lineTotalPaise(unitPricePaise, resolution.quantityMilli);
  const idempotencyKey = `subscription:${subscription.id}:${date}`;

  try {
    await db.transaction(async (tx) => {
      // Same address snapshot and society link a checkout order gets, so
      // rider dispatch, society rules and the drop address work unchanged.
      const address = subscription.addressId
        ? await tx.query.addresses.findFirst({ where: eq(addresses.id, subscription.addressId) })
        : null;
      const orderSocietyId = address
        ? await resolveAddressSociety(subscription.userId, address.societyId ?? null, tx)
        : null;
      const [order] = await tx
        .insert(orders)
        .values({
          orderNumber: generateOrderNumber(),
          userId: subscription.userId,
          shopId: subscription.shopId,
          addressId: subscription.addressId,
          deliveryAddressSnapshot: address
            ? {
                line1: address.line1,
                line2: address.line2,
                area: address.area,
                city: address.city,
                pincode: address.pincode,
                latitude: address.latitude,
                longitude: address.longitude,
                landmark: address.landmark,
                deliveryInstructions: address.deliveryInstructions,
              }
            : null,
          societyId: orderSocietyId,
          status: "PENDING",
          source: "SUBSCRIPTION",
          subtotalPaise: totalPaise,
          deliveryFeePaise: 0, // subscription deliveries are bundled
          taxPaise: 0,
          totalPaise,
          deliveryDate: date,
        })
        .returning();

      await tx.insert(orderItems).values({
        orderId: order.id,
        shopProductId: subscription.shopProductId,
        productNameSnapshot: row.product.name,
        unitSnapshot: row.product.unit,
        unitPricePaise,
        quantityMilli: resolution.quantityMilli,
        lineTotalPaise: totalPaise,
      });

      // Claims the (subscription, date) slot. A concurrent run fails here.
      await tx.insert(subscriptionOrders).values({
        subscriptionId: subscription.id,
        orderId: order.id,
        deliveryDate: date,
        quantityMilli: resolution.quantityMilli,
        unitPricePaise,
        totalPaise,
        status: "PENDING",
      });

      await consumeOnlineStock(
        subscription.shopProductId,
        unitsNeeded,
        "Subscription delivery",
        tx,
        order.id,
      );

      // Throws INSUFFICIENT_BALANCE → whole transaction rolls back.
      await applyWalletMutation(
        {
          userId: subscription.userId,
          amountPaise: totalPaise,
          type: "SUBSCRIPTION_DEDUCTION",
          idempotencyKey,
          description: `${row.product.name} — ${date}`,
          orderId: order.id,
          subscriptionId: subscription.id,
        },
        tx,
      );

      await tx
        .update(orders)
        .set({ status: "CONFIRMED", paidAt: new Date() })
        .where(eq(orders.id, order.id));
      await tx
        .update(subscriptionOrders)
        .set({ status: "CONFIRMED" })
        .where(eq(subscriptionOrders.orderId, order.id));
      await tx.insert(orderStatusHistory).values({
        orderId: order.id,
        previousStatus: "PENDING",
        newStatus: "CONFIRMED",
        note: "Subscription wallet deduction",
      });
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "INSUFFICIENT_BALANCE") {
      await recordWalletFailure(subscription, date, {
        unitPricePaise,
        quantityMilli: resolution.quantityMilli,
        totalPaise,
        productName: row.product.name,
      });
      return "WALLET_INSUFFICIENT";
    }
    throw error;
  }

  await db
    .update(subscriptions)
    .set({ status: "ACTIVE", updatedAt: new Date() })
    .where(eq(subscriptions.id, subscription.id));
  await refreshNextDeliveryDate(subscription.id);

  await notify({
    userId: subscription.userId,
    type: NOTIFICATION_TYPES.SUBSCRIPTION_ORDER_CREATED,
    title: "Today's delivery is confirmed",
    body: `${row.product.name} for ${date} — ${formatPaise(totalPaise)} deducted from your wallet.`,
    actionUrl: `/subscriptions/${subscription.id}`,
    dedupeKey: `sub-order:${subscription.id}:${date}`,
  });

  await maybeWarnLowBalance(subscription.userId);
  return "GENERATED";
}

/**
 * Records a failed day without charging anything (§39). The subscription order
 * row still claims the date, so the job stays idempotent, and the customer can
 * top up and retry.
 */
async function recordWalletFailure(
  subscription: Subscription,
  date: IsoDate,
  detail: {
    unitPricePaise: number;
    quantityMilli: number;
    totalPaise: number;
    productName: string;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [order] = await tx
      .insert(orders)
      .values({
        orderNumber: generateOrderNumber(),
        userId: subscription.userId,
        shopId: subscription.shopId,
        addressId: subscription.addressId,
        status: "WALLET_INSUFFICIENT",
        source: "SUBSCRIPTION",
        subtotalPaise: detail.totalPaise,
        totalPaise: detail.totalPaise,
        deliveryDate: date,
      })
      .returning();

    await tx.insert(orderItems).values({
      orderId: order.id,
      shopProductId: subscription.shopProductId,
      productNameSnapshot: detail.productName,
      unitSnapshot: "",
      unitPricePaise: detail.unitPricePaise,
      quantityMilli: detail.quantityMilli,
      lineTotalPaise: detail.totalPaise,
    });

    await tx.insert(subscriptionOrders).values({
      subscriptionId: subscription.id,
      orderId: order.id,
      deliveryDate: date,
      quantityMilli: detail.quantityMilli,
      unitPricePaise: detail.unitPricePaise,
      totalPaise: detail.totalPaise,
      status: "WALLET_INSUFFICIENT",
      failureReason: "Insufficient wallet balance",
    });

    await tx
      .update(subscriptions)
      .set({ status: "PAYMENT_PENDING", updatedAt: new Date() })
      .where(eq(subscriptions.id, subscription.id));
    await recordSubscriptionEvent(
      {
        subscriptionId: subscription.id,
        action: "PAYMENT_FAILED",
        fromStatus: subscription.status,
        toStatus: "PAYMENT_PENDING",
        note: `Wallet balance too low for ${date}`,
      },
      tx,
    );
  });

  await notify({
    userId: subscription.userId,
    type: NOTIFICATION_TYPES.SUBSCRIPTION_PAYMENT_FAILED,
    title: "Subscription payment failed",
    body: `Your daily subscription could not be processed because your wallet balance is insufficient. Recharge to resume delivery.`,
    actionUrl: "/wallet",
    dedupeKey: `sub-fail:${subscription.id}:${date}`,
  });
}

/**
 * Retries a previously failed day after a top-up (§39).
 * Deletes the failed claim inside a transaction, then regenerates.
 */
export async function retryFailedDelivery(
  subscriptionId: string,
  date: IsoDate,
): Promise<DeliveryOutcome> {
  const failed = await db.query.subscriptionOrders.findFirst({
    where: and(
      eq(subscriptionOrders.subscriptionId, subscriptionId),
      eq(subscriptionOrders.deliveryDate, date),
    ),
  });
  if (!failed) throw notFound("Subscription delivery");
  if (failed.status !== "WALLET_INSUFFICIENT") {
    throw conflict("This delivery does not need a retry.");
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(subscriptionOrders)
      .where(eq(subscriptionOrders.id, failed.id));
    if (failed.orderId) {
      await tx.delete(orderItems).where(eq(orderItems.orderId, failed.orderId));
      await tx.delete(orders).where(eq(orders.id, failed.orderId));
    }
  });

  const subscription = await getSubscription(subscriptionId);
  if (!subscription) throw notFound("Subscription");
  return generateOneDelivery(subscription, date);
}

/* ------------------------------------------------------------ helpers */

function toScheduleInput(
  subscription: Pick<
    Subscription,
    | "status"
    | "frequency"
    | "weekdays"
    | "quantityMilli"
    | "startDate"
    | "endDate"
    | "pauseFrom"
    | "pauseUntil"
  >,
): ScheduleInput {
  return {
    status: subscription.status,
    frequency: subscription.frequency,
    weekdays: subscription.weekdays,
    quantityMilli: subscription.quantityMilli,
    startDate: subscription.startDate,
    endDate: subscription.endDate,
    pauseFrom: subscription.pauseFrom,
    pauseUntil: subscription.pauseUntil,
  };
}

async function refreshNextDeliveryDate(subscriptionId: string): Promise<void> {
  const subscription = await getSubscription(subscriptionId);
  if (!subscription) return;

  const today = todayIn(getEnv().APP_TIMEZONE);
  const overrides = await getOverrides(subscriptionId, today);
  const map = new Map(overrides.map((o) => [o.deliveryDate, o]));

  // Look from tomorrow: today's delivery has already been decided.
  const next = nextDeliveryDate(
    toScheduleInput(subscription),
    addDays(today, 1),
    map,
  );
  await db
    .update(subscriptions)
    .set({ nextDeliveryDate: next })
    .where(eq(subscriptions.id, subscriptionId));
}

/**
 * A past or already-generated date cannot be modified — otherwise a customer
 * could retroactively change what they were charged.
 */
async function assertDateIsModifiable(
  subscriptionId: string,
  date: IsoDate,
): Promise<void> {
  const today = todayIn(getEnv().APP_TIMEZONE);
  if (date < today) {
    throw validationFailed("You cannot change a delivery in the past.");
  }

  const generated = await db.query.subscriptionOrders.findFirst({
    where: and(
      eq(subscriptionOrders.subscriptionId, subscriptionId),
      eq(subscriptionOrders.deliveryDate, date),
    ),
  });
  if (generated && generated.status !== "WALLET_INSUFFICIENT") {
    throw conflict(
      "This delivery has already been processed and can no longer be changed.",
    );
  }
}

/** One low-balance warning per crossing, not one per deduction (§24). */
async function maybeWarnLowBalance(userId: string): Promise<void> {
  const wallet = await db.query.wallets.findFirst({
    where: eq(wallets.userId, userId),
  });
  if (!wallet) return;
  if (wallet.balancePaise >= wallet.lowBalanceThresholdPaise) {
    // Back above the threshold — re-arm the warning.
    if (wallet.lowBalanceNotifiedAt) {
      await db
        .update(wallets)
        .set({ lowBalanceNotifiedAt: null })
        .where(eq(wallets.id, wallet.id));
    }
    return;
  }
  if (wallet.lowBalanceNotifiedAt) return;

  const forecast = await getWalletForecast(userId, 15);
  await notify({
    userId,
    type: NOTIFICATION_TYPES.WALLET_LOW_BALANCE,
    title: "Low wallet balance",
    body: forecast.sufficient
      ? `Your wallet balance is ${formatPaise(wallet.balancePaise)}. Consider topping up.`
      : `Your wallet balance is ${formatPaise(wallet.balancePaise)} but your next ${forecast.horizonDays} days of subscriptions need ${formatPaise(forecast.upcomingCostPaise)}. We recommend adding ${formatPaise(forecast.recommendedTopUpPaise)}.`,
    actionUrl: "/wallet",
    channels: ["IN_APP", "EMAIL"],
  });

  await db
    .update(wallets)
    .set({ lowBalanceNotifiedAt: new Date() })
    .where(eq(wallets.id, wallet.id));
}

/** Subscription orders for a shop's dashboard (§40). */
export async function listSubscriptionOrdersForShop(
  shopId: string,
  date?: IsoDate,
) {
  return db
    .select({
      subscriptionOrder: subscriptionOrders,
      subscriptionId: subscriptions.id,
      customerId: subscriptions.userId,
      productName: products.name,
      unit: products.unit,
      orderNumber: orders.orderNumber,
      orderStatus: orders.status,
    })
    .from(subscriptionOrders)
    .innerJoin(
      subscriptions,
      eq(subscriptionOrders.subscriptionId, subscriptions.id),
    )
    .innerJoin(shopProducts, eq(subscriptions.shopProductId, shopProducts.id))
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .leftJoin(orders, eq(subscriptionOrders.orderId, orders.id))
    .where(
      and(
        eq(subscriptions.shopId, shopId),
        date ? eq(subscriptionOrders.deliveryDate, date) : undefined,
      ),
    )
    .orderBy(asc(subscriptionOrders.deliveryDate));
}

export async function countSubscriptionsByStatus(): Promise<
  Record<string, number>
> {
  const rows = await db
    .select({
      status: subscriptions.status,
      count: sql<number>`count(*)::int`,
    })
    .from(subscriptions)
    .groupBy(subscriptions.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}
