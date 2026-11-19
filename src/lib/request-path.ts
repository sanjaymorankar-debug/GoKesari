/**
 * Seller Central's pages stream behind a loading skeleton (src/app/shop/loading.tsx), and once a
 * page streams its status is fixed at 200: a page's own redirect("/signin") or notFound() then
 * only acts in the browser (Next 16 streaming guide, "The HTTP contract"). The proxy hands the
 * page's path to the /shop layout in this header, so the layout can answer 307 / 404 first
 * (D-109, D-131). The proxy always overwrites it; a caller cannot choose it.
 */
export const REQUEST_PATH_HEADER = "x-gk-path";

/** Seller Central pages a signed-out visitor may open: registration (its own sign-in step) and its links. */
const SHOP_GUEST_PATHS = ["/shop/register", "/shop/join"] as const;

/** A Seller Central page that sends a signed-out visitor to sign in. */
export function shopPageNeedsSignIn(path: string): boolean {
  if (path !== "/shop" && !path.startsWith("/shop/")) return false;
  return !SHOP_GUEST_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

/** The order id in a packing-slip page's path (/shop/orders/<id>/packing-slip), else null. */
export function packingSlipOrderId(path: string): string | null {
  return /^\/shop\/orders\/([^/]+)\/packing-slip\/?$/.exec(path)?.[1] ?? null;
}
