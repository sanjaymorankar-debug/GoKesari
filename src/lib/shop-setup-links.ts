/**
 * Shared by the setup pages, the Excel preview and the error file (no server
 * imports: the preview is a client component).
 */

/** D-1: where a shop owner adds a product that is not in the GoKesari product list yet. */
export function addProductPath(shopId?: string | null): string {
  return `/shop/manage/products${shopId ? `?shop=${encodeURIComponent(shopId)}` : ""}#products`;
}

/** An upload row whose Product ID is not in the product list. Uploads checked before `code` existed say so only in the message. */
export function isUnknownProductError(e: { code?: string; message: string }): boolean {
  return e.code === "UNKNOWN_PRODUCT" || /is not in the GoKesari product list\./.test(e.message);
}
