/**
 * Flow spec v3 F13, product and inventory setup (docs/flows-v3/wave2.md; flag flow_f13).
 *
 * The "ready for product upload" e-mail: queued (document-email outbox, sent after commit) for a shop that goes live
 * by any approval path — every path queues the welcome kit (queueShopWelcomeKit), which calls this first; the
 * welcome-kit safety net covers the rest. Once per shop (the outbox's unique key). Never throws.
 *
 * The other F13 parts live where they act: shop-product-setup.ts (category → every item at stock 100; master-list
 * adds at stock 100), catalogue.ts (exact match: use existing / add new), /api/shops/[id]/product-types (own type
 * for every shop type).
 */
import type { DbClient } from "@/server/db";
import { queueDocumentEmail } from "@/server/documents/email";
import { flowOn } from "./wave2-rules";

export const READY_FOR_PRODUCTS_DOC_TYPE = "SHOP_READY_FOR_PRODUCTS";

export function readyForProductsText(shopName: string): { title: string; body: string } {
  return {
    title: `${shopName} is live — add your products`,
    body: [
      `Your shop ${shopName} is now live on GoKesari.`,
      "Customers find it in search, Nearby shops and through your shop QR code once it has products with a price and stock.",
      "Add your products now: choose your categories (every product in a category is listed at stock 100, which you can change), pick from the master list, upload an Excel file, or photograph a product with its price.",
    ].join("\n\n"),
  };
}

export async function queueReadyForProductsEmail(
  shop: { id: string; ownerId: string; name: string },
  client: DbClient,
  options: { deliverNow?: boolean } = {},
): Promise<boolean> {
  if (!(await flowOn("flow_f13"))) return false;
  try {
    const text = readyForProductsText(shop.name);
    // Its own savepoint: a failure here never rolls back the approval or the welcome kit around it.
    return await client.transaction(async (sp) => queueDocumentEmail(
      {
        docType: READY_FOR_PRODUCTS_DOC_TYPE,
        docId: shop.id,
        userId: shop.ownerId,
        recipientRole: "SHOP_OWNER",
        title: text.title,
        body: text.body,
        actionUrl: "/shop/product-categories",
        category: "SHOP",
        deliverNow: options.deliverNow,
      },
      sp,
    ));
  } catch (error) {
    console.error("[flows-v3] ready-for-products e-mail not queued", shop.id, error instanceof Error ? error.message : error);
    return false;
  }
}
