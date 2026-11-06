/**
 * "How you deliver" (onboarding Phase 2, WP3 — docs/onboarding-benchmark/phase-2): the one choice a
 * new shop makes about delivery. Client-safe: the set-up page, the checklist and the server share it.
 *
 * Own staff and GoKesari riders both turn delivery on (`shops.delivery_available`); pickup only
 * turns it off. Who takes a given order is still chosen per order (lib/fulfilment-options.ts).
 */
export const SHOP_DELIVERY_CHOICES = ["OWN_STAFF", "GOKESARI_PARTNER", "PICKUP_ONLY"] as const;
export type ShopDeliveryChoice = (typeof SHOP_DELIVERY_CHOICES)[number];

export const SHOP_DELIVERY_CHOICE_TEXT: Record<ShopDeliveryChoice, { label: string; hint: string; icon: string }> = {
  OWN_STAFF: { label: "My own delivery staff", hint: "Your people deliver; add them under Delivery staff.", icon: "🛵" },
  GOKESARI_PARTNER: { label: "GoKesari delivery partners", hint: "A GoKesari rider collects from your shop where riders cover your area.", icon: "🚚" },
  PICKUP_ONLY: { label: "Pickup only", hint: "Customers collect from your shop with a pickup code. No delivery.", icon: "🏪" },
};

/** Delivery is on for every choice except pickup only. */
export function deliversFor(choice: ShopDeliveryChoice): boolean {
  return choice !== "PICKUP_ONLY";
}
