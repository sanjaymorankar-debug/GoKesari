/** Sort orders the Shops page offers (the `sort` URL parameter). */
export const SHOP_SORTS = [
  { key: "nearest", label: "Nearest first" },
  { key: "name", label: "Name A–Z" },
  { key: "rating", label: "Top rated" },
] as const;

export type ShopSort = (typeof SHOP_SORTS)[number]["key"];

export function parseShopSort(value: string | undefined, hasLocation: boolean): ShopSort {
  const known = SHOP_SORTS.find((s) => s.key === value)?.key;
  if (known && (known !== "nearest" || hasLocation)) return known;
  return hasLocation ? "nearest" : "name";
}
