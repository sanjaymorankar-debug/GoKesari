/**
 * "Registration successful — ready for product upload" (docs/dealer-programme,
 * GKS-SH-004): sent to the owner when a shop is approved instantly on GST/PAN
 * verification + payment, in the app and by email (the notification outbox
 * retries a failed email; the approval never depends on it), with the shop ID
 * and direct links to add products. The dealer the shop is counted for is told
 * too.
 */
import { eq } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { db } from "@/server/db";
import { dealers, shopAttributions, type Shop } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { notify } from "./notifications";
import { isDocumentsLaterShop } from "./shop-onboarding";

function siteUrl(path: string): string {
  const base = (getEnv().AUTH_URL ?? "https://gokesari.com").replace(/\/$/, "");
  return `${base}${path}`;
}

export async function sendReadyForProductUpload(shop: Shop): Promise<void> {
  try {
    // A shop registered with "add documents later" had no GST / PAN check (onboarding Phase B, G10).
    const later = await isDocumentsLaterShop(shop.id);
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.SHOP_READY_FOR_PRODUCT_UPLOAD,
      vars: {
        shopName: shop.name,
        shopId: shop.registrationNumber ?? shop.id,
        addProductsUrl: siteUrl("/shop/manage/products"),
        bulkUploadUrl: siteUrl("/shop/product-import"),
        checkedLine: later
          ? "Your registration fee is received,"
          : "Your GST/PAN was verified with the government records and your registration fee is received,",
        payoutLine: later ? ". Add your GST number or PAN on Documents before your first payout — payouts start once it is verified." : "",
      },
      actionUrl: "/shop/manage/products",
      dedupeKey: `shop-ready:${shop.id}`,
    });
    const [attributed] = await db
      .select({ userId: dealers.userId, isInternal: dealers.isInternal })
      .from(shopAttributions)
      .innerJoin(dealers, eq(dealers.id, shopAttributions.dealerId))
      .where(eq(shopAttributions.shopId, shop.id));
    if (attributed?.userId && !attributed.isInternal) {
      await notify({
        userId: attributed.userId,
        type: NOTIFICATION_TYPES.DEALER_SHOP_APPROVED,
        vars: { shopName: shop.name },
        actionUrl: "/dealer",
        dedupeKey: `dealer-shop-approved:${shop.id}`,
      });
    }
  } catch (error) {
    // The shop is approved whatever happens here; notify() itself queues and retries delivery.
    console.error("[shop-ready] notice failed", shop.id, error instanceof Error ? error.message : error);
  }
}
