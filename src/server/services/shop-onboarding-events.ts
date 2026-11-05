/**
 * Notices for onboarding milestones after go-live (onboarding Phase B, B2): sent the moment the
 * change happens (no cron), to the owner and the dealer the shop is counted for. Best-effort —
 * the milestone itself never depends on a notice; notify() queues and retries delivery.
 */
import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { dealers, shopAttributions, shops } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { notify } from "./notifications";

/** A shop's first products went live (the starter shelf, or the first product added). */
export async function notifyFirstProducts(shopId: string, count: number): Promise<void> {
  try {
    const [shop] = await db.select({ name: shops.name, ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId));
    if (!shop) return;
    const vars = { shopName: shop.name, count: String(count) };
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.SHOP_FIRST_PRODUCTS_LIVE,
      vars,
      actionUrl: "/shop/manage/products",
      dedupeKey: `shop-first-products:${shopId}`,
    });
    const [attributed] = await db
      .select({ userId: dealers.userId, isInternal: dealers.isInternal })
      .from(shopAttributions)
      .innerJoin(dealers, eq(dealers.id, shopAttributions.dealerId))
      .where(eq(shopAttributions.shopId, shopId));
    if (attributed?.userId && !attributed.isInternal) {
      await notify({
        userId: attributed.userId,
        type: NOTIFICATION_TYPES.DEALER_SHOP_FIRST_PRODUCTS,
        vars,
        actionUrl: "/dealer",
        dedupeKey: `dealer-shop-first-products:${shopId}`,
      });
    }
  } catch (error) {
    console.error("[onboarding] first-products notice failed", shopId, error instanceof Error ? error.message : error);
  }
}
