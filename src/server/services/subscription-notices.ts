/**
 * The shop's notice of new subscribers (docs/newspaper-subscriptions-2026-11).
 *
 * Before this the shop learned of a subscription only when its first daily
 * order appeared. Now the owner is told at once — one notice per submission,
 * so a customer taking three newspapers together is one notice listing all
 * three — with the customer, what, how often, from when and where.
 *
 * Never fails the subscription itself: a notice that cannot be sent is logged.
 */
import { eq, inArray } from "drizzle-orm";

import { formatDisplayDate, type IsoDate } from "@/lib/dates";
import { formatQuantity, MILLI_PER_UNIT } from "@/lib/money";
import { copiesLabel, scheduleLabel } from "@/lib/periodicals";
import { slotLabel, type PlanSlot } from "@/lib/subscription-plans";
import { db } from "@/server/db";
import { addresses, periodicalTitles, products, shopProducts, shops, subscriptionPlans, users, type Subscription } from "@/server/db/schema";
import { NOTIFICATION_TYPES, notify } from "./notifications";

type NoticeSubscription = Pick<
  Subscription,
  "id" | "userId" | "shopId" | "shopProductId" | "addressId" | "quantityMilli" | "frequency" | "weekdays" | "monthDays" | "startDate" | "bundleId"
> & { planId?: string | null };

/** "The Hindu (1 copy, every day)" / "Cow Milk (2 L, every day)". */
export function describeSubscriptionLine(line: {
  productName: string;
  unit: string;
  isPeriodical: boolean;
  quantityMilli: number;
  frequency: Subscription["frequency"];
  weekdays: number[];
  monthDays: number[];
  /** The plan it was taken on (docs/subscription-plans-2026-11): its name leads, its slot follows. */
  plan?: { name: string; slot: PlanSlot; slotWindow: string | null } | null;
}): string {
  const amount = line.isPeriodical ? copiesLabel(line.quantityMilli / MILLI_PER_UNIT) : formatQuantity(line.quantityMilli, line.unit);
  const when = scheduleLabel({ frequency: line.frequency, weekdays: line.weekdays, monthDays: line.monthDays });
  const parts = [amount, when === "Every day" ? "every day" : when];
  if (line.plan) parts.push(slotLabel(line.plan.slot, line.plan.slotWindow));
  return `${line.plan?.name ?? line.productName} (${parts.join(", ")})`;
}

/** Tells each shop owner about the new subscriptions to their shop. All of `subs` share one customer. */
export async function notifyShopOfNewSubscriptions(subs: NoticeSubscription[]): Promise<void> {
  if (subs.length === 0) return;
  try {
    const lines = await db
      .select({
        shopProductId: shopProducts.id,
        productName: products.name,
        unit: products.unit,
        periodical: periodicalTitles.productId,
      })
      .from(shopProducts)
      .innerJoin(products, eq(products.id, shopProducts.productId))
      .leftJoin(periodicalTitles, eq(periodicalTitles.productId, products.id))
      .where(inArray(shopProducts.id, [...new Set(subs.map((s) => s.shopProductId))]));
    const lineOf = new Map(lines.map((l) => [l.shopProductId, l]));
    const planIds = [...new Set(subs.map((s) => s.planId).filter((id): id is string => Boolean(id)))];
    const plans = planIds.length
      ? await db
          .select({ id: subscriptionPlans.id, name: subscriptionPlans.name, slot: subscriptionPlans.slot, slotWindow: subscriptionPlans.slotWindow })
          .from(subscriptionPlans)
          .where(inArray(subscriptionPlans.id, planIds))
      : [];
    const planOf = new Map(plans.map((p) => [p.id, p]));

    const [customer] = await db.select({ name: users.name }).from(users).where(eq(users.id, subs[0].userId)).limit(1);
    const addressId = subs.find((s) => s.addressId)?.addressId ?? null;
    const [address] = addressId
      ? await db
          .select({ area: addresses.area, city: addresses.city, pincode: addresses.pincode })
          .from(addresses)
          .where(eq(addresses.id, addressId))
          .limit(1)
      : [];

    const byShop = new Map<string, NoticeSubscription[]>();
    for (const sub of subs) byShop.set(sub.shopId, [...(byShop.get(sub.shopId) ?? []), sub]);

    for (const [shopId, shopSubs] of byShop) {
      const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId)).limit(1);
      if (!shop) continue;
      const items = shopSubs.map((sub) => {
        const line = lineOf.get(sub.shopProductId);
        return describeSubscriptionLine({
          productName: line?.productName ?? "a product",
          unit: line?.unit ?? "",
          isPeriodical: Boolean(line?.periodical),
          quantityMilli: sub.quantityMilli,
          frequency: sub.frequency,
          weekdays: sub.weekdays,
          monthDays: sub.monthDays ?? [],
          plan: sub.planId ? (planOf.get(sub.planId) ?? null) : null,
        });
      });
      const startDate = shopSubs.map((s) => s.startDate).sort()[0] as IsoDate;
      const where = address ? [address.area, address.city, address.pincode].filter(Boolean).join(", ") : null;
      const customerName = customer?.name?.trim() || "A customer";
      await notify({
        userId: shop.ownerId,
        type: NOTIFICATION_TYPES.SHOP_NEW_SUBSCRIPTION,
        title: shopSubs.length === 1 ? "New subscriber" : `New subscriber — ${shopSubs.length} items`,
        body:
          `${customerName} subscribed to ${items.join("; ")}, starting ${formatDisplayDate(startDate)}.` +
          (where ? ` Deliver to: ${where}.` : ""),
        actionUrl: "/shop/manage/subscribers",
        metadata: { subscriptionIds: shopSubs.map((s) => s.id), bundleId: shopSubs[0].bundleId ?? null },
        dedupeKey: `shop-new-subscription:${shopSubs[0].bundleId ?? shopSubs[0].id}`,
      });
    }
  } catch (error) {
    console.error("[subscriptions] shop notice failed", subs.map((s) => s.id), error);
  }
}
