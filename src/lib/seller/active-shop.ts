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
