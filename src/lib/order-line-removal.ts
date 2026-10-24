/**
 * Why a shop takes a line off an order while packing it (GS-035: the line is
 * removed and refunded). One list for the shop screen and the fulfilment API,
 * so the API accepts only what the screen offers (TC-FLD-083: "Banana" was
 * saved as a reason). Client-safe.
 *
 * The shop's "Unavailable — remove & refund" button sends "Out of stock". A
 * request without a reason keeps the long-standing default, "Unavailable".
 */
export const REMOVE_LINE_REASONS = ["Out of stock", "Unavailable"] as const;
export type RemoveLineReason = (typeof REMOVE_LINE_REASONS)[number];

/** What the shop screen's button sends. */
export const SHOP_REMOVE_LINE_REASON: RemoveLineReason = "Out of stock";
/** Saved when the request names no reason. */
export const DEFAULT_REMOVE_LINE_REASON: RemoveLineReason = "Unavailable";
