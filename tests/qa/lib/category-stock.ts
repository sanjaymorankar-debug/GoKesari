/**
 * Adding a category lists nothing (docs/shop-product-setup-2026-11). A QA shop
 * that needs a full shelf picks every product of the category and gives each a
 * quantity, through the same APIs as the owner's setup flow.
 */
import type { APIRequestContext } from "@playwright/test";

import { call, expectStatus } from "./http";

export async function stockWholeCategory(ctx: APIRequestContext, shopId: string, categoryId: string, stock = 100): Promise<void> {
  const base = `/api/shops/${shopId}/product-setup`;
  const ids = await call(ctx, "GET", `${base}/products?ids=1&category=${categoryId}`);
  expectStatus(ids, 200, "the category's products");
  if ((ids.body.ids as string[]).length) expectStatus(await call(ctx, "POST", `${base}/products`, { productIds: ids.body.ids }), 200, "pick the products");
  const inv = await call(ctx, "GET", `/api/shops/${shopId}/inventory`);
  expectStatus(inv, 200, "the inventory");
  const rows = (inv.body.rows as { shopProductId: string }[]).map((r) => ({ shopProductId: r.shopProductId, stock }));
  for (let i = 0; i < rows.length; i += 200) {
    expectStatus(await call(ctx, "POST", `${base}/listings`, { action: "live", rows: rows.slice(i, i + 200) }), 200, "set the stock");
  }
}
