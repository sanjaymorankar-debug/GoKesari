/**
 * Subscription plans (docs/subscription-plans-2026-11): any shop offers one of
 * its products on repeat — a tiffin kitchen's lunch, a dairy's milk, a paper
 * agent's newspaper — and customers subscribe within the plan's rules.
 *
 * The plan only frames the subscription: once taken, it is an ordinary
 * subscription (services/subscriptions.ts) that generates one order per
 * delivery day, charged at the plan's price.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { addDays, dateRange, todayIn, type IsoDate } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import {
  ALL_WEEKDAYS,
  PLAN_KINDS,
  PLAN_SLOTS,
  planRulesProblem,
  type PlanKind,
  type PlanSlot,
} from "@/lib/subscription-plans";
import { sortedUnique, type SubscriptionFrequency } from "@/lib/periodicals";
import { db } from "@/server/db";
import { isUniqueViolation } from "@/server/db/upsert";
import {
  addresses,
  periodicalTitles,
  products,
  shopProducts,
  shops,
  subscriptionDailyOverrides,
  subscriptionPlans,
  subscriptions,
  type Subscription,
  type SubscriptionPlan,
  type UserRole,
} from "@/server/db/schema";
import { locationFromAddress } from "@/server/location";
import type { CustomerLocation } from "@/lib/location";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { listServiceableShops } from "./serviceability";
import {
  createSubscription,
  DELIVERING_STATUSES,
  resolveDelivery,
  subscriptionUnitPrice,
  toScheduleInput,
} from "./subscriptions";

type Actor = { id: string; role: UserRole };

/* ------------------------------------------------------------ input */

export interface PlanInput {
  shopProductId: string;
  name: string;
  description?: string | null;
  kind: PlanKind;
  slot: PlanSlot;
  slotWindow?: string | null;
  serviceDays: number[];
  allowedFrequencies: SubscriptionFrequency[];
  pricePaise?: number | null;
  termDays?: number[];
  leadDays?: number;
  isActive?: boolean;
}

function tidy(input: PlanInput) {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) throw validationFailed("Give the plan a name of 2 to 120 characters.");
  if (!PLAN_KINDS.includes(input.kind)) throw validationFailed("Choose what kind of plan this is.");
  if (!PLAN_SLOTS.includes(input.slot)) throw validationFailed("Choose the delivery slot.");
  if (input.pricePaise != null && (!Number.isInteger(input.pricePaise) || input.pricePaise <= 0)) {
    throw validationFailed("The subscriber price must be more than ₹0.");
  }
  const rules = {
    allowedFrequencies: [...new Set(input.allowedFrequencies)].filter((f): f is SubscriptionFrequency =>
      ["DAILY", "WEEKLY", "MONTHLY"].includes(f),
    ),
    serviceDays: sortedUnique(input.serviceDays),
    termDays: sortedUnique(input.termDays ?? []),
    leadDays: input.leadDays ?? 1,
  };
  const problem = planRulesProblem(rules);
  if (problem) throw validationFailed(problem);
  return {
    name,
    description: input.description?.trim() || null,
    kind: input.kind,
    slot: input.slot,
    slotWindow: input.slotWindow?.trim().slice(0, 40) || null,
    pricePaise: input.pricePaise ?? null,
    ...rules,
  };
}

/** The listing must be this shop's own, live one. */
async function assertOwnListing(shopId: string, shopProductId: string) {
  const [row] = await db
    .select({ sp: shopProducts, product: products })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(and(eq(shopProducts.id, shopProductId), isNull(shopProducts.deletedAt)))
    .limit(1);
  if (!row || row.sp.shopId !== shopId) throw validationFailed("Choose one of your shop's products.");
  return row;
}

/* ------------------------------------------------------------ shop side */

export interface ShopPlanView extends SubscriptionPlan {
  productName: string;
  unit: string;
  unitSizeMilli: number;
  /** The listing's own online price, shown beside the subscriber price. */
  listingPricePaise: number | null;
  /** What a subscriber pays per unit: subscriber price, else the listing's. */
  effectivePricePaise: number | null;
  /** Running subscriptions on this plan (active, paused, payment or renewal pending). */
  subscribers: number;
}

export async function listShopPlans(shopId: string): Promise<ShopPlanView[]> {
  const rows = await db
    .select({ plan: subscriptionPlans, sp: shopProducts, product: products })
    .from(subscriptionPlans)
    .innerJoin(shopProducts, eq(shopProducts.id, subscriptionPlans.shopProductId))
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(and(eq(subscriptionPlans.shopId, shopId), isNull(subscriptionPlans.deletedAt)))
    .orderBy(asc(subscriptionPlans.slot), asc(subscriptionPlans.name));
  const counts = rows.length
    ? await db
        .select({ planId: subscriptions.planId, n: sql<number>`count(*)::int` })
        .from(subscriptions)
        .where(
          and(
            inArray(subscriptions.planId, rows.map((r) => r.plan.id)),
            inArray(subscriptions.status, [...DELIVERING_STATUSES, "PAUSED"]),
          ),
        )
        .groupBy(subscriptions.planId)
    : [];
  const countOf = new Map(counts.map((c) => [c.planId, c.n]));
  return rows.map((r) => ({
    ...r.plan,
    productName: r.product.name,
    unit: r.product.unit,
    unitSizeMilli: r.product.unitSizeMilli,
    listingPricePaise: r.sp.onlinePricePaise,
    effectivePricePaise: subscriptionUnitPrice(r.plan, r.sp),
    subscribers: countOf.get(r.plan.id) ?? 0,
  }));
}

export async function createPlan(shopId: string, input: PlanInput, actor: Actor): Promise<SubscriptionPlan> {
  const values = tidy(input);
  const listing = await assertOwnListing(shopId, input.shopProductId);
  if (values.pricePaise == null && listing.sp.onlinePricePaise == null) {
    throw validationFailed("Set a subscriber price: this product has no online price.");
  }
  try {
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({ shopId, shopProductId: input.shopProductId, ...values, isActive: input.isActive ?? true, createdBy: actor.id })
      .returning();
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SUBSCRIPTION_PLAN_CREATED,
      entityType: "subscription_plan",
      entityId: plan.id,
      newValue: { shopId, ...values },
    });
    return plan;
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("You already have a plan with this name.");
    throw error;
  }
}

async function ownPlan(shopId: string, planId: string): Promise<SubscriptionPlan> {
  const plan = await db.query.subscriptionPlans.findFirst({
    where: and(eq(subscriptionPlans.id, planId), isNull(subscriptionPlans.deletedAt)),
  });
  if (!plan) throw notFound("Subscription plan");
  if (plan.shopId !== shopId) throw forbidden("This plan belongs to another shop.");
  return plan;
}

/**
 * Changes a plan. Running subscribers keep their schedule; a price change
 * applies from their next delivery (as a listing price change does), and the
 * product cannot be swapped under them.
 */
export async function updatePlan(shopId: string, planId: string, input: PlanInput, actor: Actor): Promise<SubscriptionPlan> {
  const current = await ownPlan(shopId, planId);
  const values = tidy(input);
  if (input.shopProductId !== current.shopProductId) {
    const running = await db.$count(
      subscriptions,
      and(eq(subscriptions.planId, planId), inArray(subscriptions.status, [...DELIVERING_STATUSES, "PAUSED", "DRAFT"])),
    );
    if (running > 0) throw conflict("This plan has subscribers, so its product cannot change. Make a new plan instead.");
  }
  const listing = await assertOwnListing(shopId, input.shopProductId);
  if (values.pricePaise == null && listing.sp.onlinePricePaise == null) {
    throw validationFailed("Set a subscriber price: this product has no online price.");
  }
  try {
    const [plan] = await db
      .update(subscriptionPlans)
      .set({ shopProductId: input.shopProductId, ...values, isActive: input.isActive ?? current.isActive, updatedAt: new Date() })
      .where(eq(subscriptionPlans.id, planId))
      .returning();
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SUBSCRIPTION_PLAN_UPDATED,
      entityType: "subscription_plan",
      entityId: planId,
      previousValue: current,
      newValue: plan,
    });
    return plan;
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("You already have a plan with this name.");
    throw error;
  }
}

/** Switches a plan on or off without touching anything else. */
export async function setPlanActive(shopId: string, planId: string, isActive: boolean, actor: Actor): Promise<SubscriptionPlan> {
  await ownPlan(shopId, planId);
  const [plan] = await db
    .update(subscriptionPlans)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(subscriptionPlans.id, planId))
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SUBSCRIPTION_PLAN_UPDATED,
    entityType: "subscription_plan",
    entityId: planId,
    newValue: { isActive },
  });
  return plan;
}

/** Removes a plan from the shop's list. Running subscribers keep their deliveries until they cancel. */
export async function removePlan(shopId: string, planId: string, actor: Actor): Promise<void> {
  await ownPlan(shopId, planId);
  await db
    .update(subscriptionPlans)
    .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(subscriptionPlans.id, planId));
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SUBSCRIPTION_PLAN_REMOVED,
    entityType: "subscription_plan",
    entityId: planId,
  });
}

/* ------------------------------------------------------------ customer side */

export interface PublicPlan {
  id: string;
  name: string;
  description: string | null;
  kind: PlanKind;
  slot: PlanSlot;
  slotWindow: string | null;
  serviceDays: number[];
  allowedFrequencies: SubscriptionFrequency[];
  termDays: number[];
  leadDays: number;
  /** Per unit, what a subscriber pays. */
  pricePaise: number;
  shopProductId: string;
  productName: string;
  unit: string;
  unitSizeMilli: number;
  isPeriodical: boolean;
  shop: { id: string; name: string; slug: string };
}

/** Plans a customer can take: switched on, the shop live, the listing active and available, a price to charge. */
function liveConditions() {
  return and(
    isNull(subscriptionPlans.deletedAt),
    eq(subscriptionPlans.isActive, true),
    eq(shops.status, "APPROVED"),
    isNull(shops.deletedAt),
    isNull(shopProducts.deletedAt),
    eq(shopProducts.isActive, true),
    eq(shopProducts.isAvailable, true),
    sql`coalesce(${subscriptionPlans.pricePaise}, ${shopProducts.onlinePricePaise}) is not null`,
  );
}

async function selectPublicPlans(where: ReturnType<typeof and>): Promise<PublicPlan[]> {
  const rows = await db
    .select({ plan: subscriptionPlans, sp: shopProducts, product: products, shop: shops, periodical: periodicalTitles.productId })
    .from(subscriptionPlans)
    .innerJoin(shops, eq(shops.id, subscriptionPlans.shopId))
    .innerJoin(shopProducts, eq(shopProducts.id, subscriptionPlans.shopProductId))
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .leftJoin(periodicalTitles, eq(periodicalTitles.productId, products.id))
    .where(and(liveConditions(), where))
    .orderBy(asc(subscriptionPlans.slot), asc(subscriptionPlans.name))
    .limit(500);
  return rows.map((r) => ({
    id: r.plan.id,
    name: r.plan.name,
    description: r.plan.description,
    kind: r.plan.kind,
    slot: r.plan.slot,
    slotWindow: r.plan.slotWindow,
    serviceDays: r.plan.serviceDays,
    allowedFrequencies: r.plan.allowedFrequencies,
    termDays: r.plan.termDays,
    leadDays: r.plan.leadDays,
    pricePaise: subscriptionUnitPrice(r.plan, r.sp)!,
    shopProductId: r.sp.id,
    productName: r.product.name,
    unit: r.product.unit,
    unitSizeMilli: r.product.unitSizeMilli,
    isPeriodical: Boolean(r.periodical),
    shop: { id: r.shop.id, name: r.shop.name, slug: r.shop.slug },
  }));
}

/** One plan a customer can take now, or null. */
export async function getPublicPlan(planId: string): Promise<PublicPlan | null> {
  const [plan] = await selectPublicPlans(and(eq(subscriptionPlans.id, planId)));
  return plan ?? null;
}

/** A shop's plans for its public page. */
export async function listPublicPlansForShop(shopId: string): Promise<PublicPlan[]> {
  return selectPublicPlans(and(eq(subscriptionPlans.shopId, shopId)));
}

export interface NearbyPlan extends PublicPlan {
  distanceKm: number | null;
  societyPartner: boolean;
}

/**
 * Plans of the shops that deliver to `location` — the same serviceability
 * as checkout (radius, delivery PIN codes, society partners) — optionally of
 * one kind or slot; society partners first, then nearest, then by name.
 */
export async function findPlansNear(
  location: CustomerLocation,
  filter: { kind?: PlanKind; slot?: PlanSlot } = {},
): Promise<NearbyPlan[]> {
  const serving = await listServiceableShops(location, { limit: 500 });
  if (serving.length === 0) return [];
  const byShop = new Map(serving.map((s) => [s.id, s]));
  const plans = await selectPublicPlans(
    and(
      inArray(subscriptionPlans.shopId, [...byShop.keys()]),
      filter.kind ? eq(subscriptionPlans.kind, filter.kind) : undefined,
      filter.slot ? eq(subscriptionPlans.slot, filter.slot) : undefined,
    ),
  );
  return plans
    .map((p) => {
      const shop = byShop.get(p.shop.id)!;
      return { ...p, distanceKm: shop.distanceKm, societyPartner: Boolean(shop.societyPartner) };
    })
    .sort(
      (a, b) =>
        Number(b.societyPartner) - Number(a.societyPartner) ||
        (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY) ||
        a.shop.name.localeCompare(b.shop.name) ||
        a.name.localeCompare(b.name),
    );
}

export interface SubscribeToPlanInput {
  userId: string;
  planId: string;
  quantityMilli: number;
  frequency: SubscriptionFrequency;
  weekdays?: number[];
  monthDays?: number[];
  startDate: IsoDate;
  endDate?: IsoDate | null;
  termDays?: number | null;
  addressId: string;
  draft?: boolean;
}

/**
 * Takes a plan. The shop must deliver to the chosen address; everything else
 * — the plan's days, frequencies, terms, lead days and price — is checked by
 * the engine (createSubscription with planId), which also tells the shop.
 */
export async function subscribeToPlan(input: SubscribeToPlanInput): Promise<Subscription> {
  const plan = await getPublicPlan(input.planId);
  if (!plan) throw notFound("Subscription plan");
  const [address] = await db
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, input.addressId), eq(addresses.userId, input.userId), isNull(addresses.deletedAt)))
    .limit(1);
  if (!address) throw validationFailed("Choose one of your saved delivery addresses.");
  const serving = await listServiceableShops(locationFromAddress(address), { limit: 500 });
  if (!serving.some((s) => s.id === plan.shop.id)) {
    throw validationFailed(`${plan.shop.name} does not deliver to the chosen address.`);
  }
  return createSubscription({
    userId: input.userId,
    shopProductId: plan.shopProductId,
    planId: plan.id,
    quantityMilli: input.quantityMilli,
    frequency: input.frequency,
    weekdays: input.weekdays,
    monthDays: input.monthDays,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    termDays: input.termDays ?? null,
    addressId: input.addressId,
    draft: input.draft ?? false,
  });
}

/* ------------------------------------------------------------ the shop's prep sheet */

export interface PrepSheetRow {
  /** Plan id, or "product:<shopProductId>" for subscriptions without a plan. */
  key: string;
  label: string;
  slot: PlanSlot | null;
  slotWindow: string | null;
  unit: string;
  isPeriodical: boolean;
  /** Per date: subscribers delivering and the total quantity (milli-units). */
  days: Record<IsoDate, { deliveries: number; quantityMilli: number }>;
}

export interface PrepSheet {
  dates: IsoDate[];
  rows: PrepSheetRow[];
}

/**
 * What the shop must prepare and deliver on each of the next `days` days
 * (from tomorrow by default), per plan (or per product for subscriptions
 * without a plan): how many deliveries and how much in all — skips, pauses,
 * one-day changes and serving days included, from the same schedule engine
 * the daily orders use.
 */
export async function planPrepSheet(shopId: string, options: { from?: IsoDate; days?: number } = {}): Promise<PrepSheet> {
  const from = options.from ?? addDays(todayIn(getEnv().APP_TIMEZONE), 1);
  const dates = dateRange(from, Math.min(Math.max(options.days ?? 7, 1), 31));
  const until = dates[dates.length - 1];

  const rows = await db
    .select({ sub: subscriptions, plan: subscriptionPlans, product: products, periodical: periodicalTitles.productId })
    .from(subscriptions)
    .innerJoin(shopProducts, eq(shopProducts.id, subscriptions.shopProductId))
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .leftJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
    .leftJoin(periodicalTitles, eq(periodicalTitles.productId, products.id))
    .where(and(eq(subscriptions.shopId, shopId), inArray(subscriptions.status, [...DELIVERING_STATUSES, "PAUSED"])));
  if (rows.length === 0) return { dates, rows: [] };

  const overrides = await db
    .select()
    .from(subscriptionDailyOverrides)
    .where(
      and(
        inArray(subscriptionDailyOverrides.subscriptionId, rows.map((r) => r.sub.id)),
        sql`${subscriptionDailyOverrides.deliveryDate} between ${from} and ${until}`,
      ),
    );
  const overrideOf = new Map(overrides.map((o) => [`${o.subscriptionId}|${o.deliveryDate}`, o]));

  const sheet = new Map<string, PrepSheetRow>();
  for (const r of rows) {
    const key = r.plan?.id ?? `product:${r.sub.shopProductId}`;
    const row =
      sheet.get(key) ??
      ({
        key,
        label: r.plan?.name ?? r.product.name,
        slot: r.plan?.slot ?? null,
        slotWindow: r.plan?.slotWindow ?? null,
        unit: r.product.unit,
        isPeriodical: Boolean(r.periodical),
        days: Object.fromEntries(dates.map((d) => [d, { deliveries: 0, quantityMilli: 0 }])),
      } satisfies PrepSheetRow);
    sheet.set(key, row);
    for (const date of dates) {
      const result = resolveDelivery(toScheduleInput(r.sub), date, overrideOf.get(`${r.sub.id}|${date}`) ?? null);
      if (result.delivers) {
        row.days[date].deliveries += 1;
        row.days[date].quantityMilli += result.quantityMilli;
      }
    }
  }
  const slotOrder = (s: PlanSlot | null) => (s ? PLAN_SLOTS.indexOf(s) : PLAN_SLOTS.length);
  return {
    dates,
    rows: [...sheet.values()].sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot) || a.label.localeCompare(b.label)),
  };
}

/** Every weekday — the default serving days of a new plan. */
export const DEFAULT_SERVICE_DAYS: number[] = [...ALL_WEEKDAYS];
