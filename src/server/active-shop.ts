import { cookies } from "next/headers";

import { ACTIVE_SHOP_COOKIE, pickActiveShop } from "@/lib/seller/active-shop";

/**
 * The owner's shop a Seller Central page works on: `requested` (the page's
 * `?shop=`), else the one chosen in the shop switcher, else the newest.
 * `shops` is the owner's list from `listShopsForOwner`.
 */
export async function activeShop<T extends { id: string }>(shops: readonly T[], requested?: string | null): Promise<T> {
  let remembered: string | undefined;
  try {
    remembered = (await cookies()).get(ACTIVE_SHOP_COOKIE)?.value;
  } catch {
    remembered = undefined;
  }
  return pickActiveShop(shops, requested, remembered);
}
