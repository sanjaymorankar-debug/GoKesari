/**
 * Which of an owner's shops Seller Central shows. An owner can have several
 * shops; every /shop page works on one of them: the shop named in the link
 * (`?shop=`), else the one last chosen in the top bar's shop switcher (a
 * cookie), else the newest (the order `listShopsForOwner` returns).
 */
export const ACTIVE_SHOP_COOKIE = "gk_shop";
export const ACTIVE_SHOP_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** The shop to show; `shops[0]` when neither id names one of these shops. */
export function pickActiveShop<T extends { id: string }>(
  shops: readonly T[],
  requested?: string | null,
  remembered?: string | null,
): T {
  return (
    (requested ? shops.find((s) => s.id === requested) : undefined) ??
    (remembered ? shops.find((s) => s.id === remembered) : undefined) ??
    shops[0]
  );
}

/**
 * D-3: the Seller Central page in `referer` without its `?shop=`, when that names a shop other than
 * `shopId` (the one just chosen in the switcher); else null. Only the path and query are kept, so
 * the result is always a page of this site.
 */
export function pageWithoutOtherShop(referer: string | null | undefined, shopId: string): string | null {
  if (!referer) return null;
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return null;
  }
  const named = url.searchParams.get("shop");
  if (!named || named === shopId) return null;
  if (url.pathname !== "/shop" && !url.pathname.startsWith("/shop/")) return null;
  url.searchParams.delete("shop");
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}
