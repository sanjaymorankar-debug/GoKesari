/**
 * Order and return status groups shared by the board badges and the list
 * tabs they open, so a badge and the tab it leads to always count the same
 * records. Pure data: safe in server, client and test code.
 */

export const SHOP_ORDER_TABS = {
  new: ["CONFIRMED"],
  packing: ["ACCEPTED", "PREPARING"],
  ready: ["READY", "ASSIGNED"],
  out: ["PICKED_UP", "OUT_FOR_DELIVERY"],
} as const satisfies Record<string, readonly string[]>;

export type ShopOrderTab = keyof typeof SHOP_ORDER_TABS | "done" | "all";

/** Every status counted as "in progress" (customer Active, shop active orders). */
export const IN_PROGRESS_ORDER_STATUSES = [
  ...SHOP_ORDER_TABS.new,
  ...SHOP_ORDER_TABS.packing,
  ...SHOP_ORDER_TABS.ready,
  ...SHOP_ORDER_TABS.out,
] as readonly string[];

export const RETURN_REQUEST_STATUSES = ["RETURN_REQUESTED", "UNDER_REVIEW"] as readonly string[];
export const RETURN_PICKUP_STATUSES = ["APPROVED", "PICKUP_ASSIGNED", "PICKUP_SCHEDULED", "RIDER_EN_ROUTE"] as readonly string[];

/** Reads `?status=` / `?tab=` leniently: anything unknown is the fallback. */
export function pickTab<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
