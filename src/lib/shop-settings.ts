/**
 * Field rules for a shop's own details, shared by registration (POST
 * /api/shops), the owner's settings PATCH (/api/shops/[id]) and the owner's
 * forms, so every path refuses the same values. Client-safe: zod only.
 */
import { z } from "zod";

/* ------------------------------------------------------------ amounts */

/** Largest minimum-order value a shop may set: ₹1 lakh (TC-FLD-051). */
export const MAX_MIN_ORDER_PAISE = 10_000_000;
/** Largest delivery fee: ₹5,000 (TC-FLD-053). */
export const MAX_DELIVERY_FEE_PAISE = 500_000;
/** Largest "free delivery above" threshold: ₹1 lakh (TC-FLD-053). */
export const MAX_FREE_DELIVERY_ABOVE_PAISE = 10_000_000;

/** How long a shop takes to prepare an order, in minutes (TC-FLD-054). */
export const MIN_PREPARATION_MINUTES = 5;
export const MAX_PREPARATION_MINUTES = 240;

export const minOrderPaiseSchema = z
  .number()
  .int()
  .min(0, "Minimum order can't be negative.")
  .max(MAX_MIN_ORDER_PAISE, "Minimum order can be at most ₹1,00,000.");
export const deliveryFeePaiseSchema = z
  .number()
  .int()
  .min(0, "Delivery fee can't be negative.")
  .max(MAX_DELIVERY_FEE_PAISE, "Delivery fee can be at most ₹5,000.");
export const freeDeliveryAbovePaiseSchema = z
  .number()
  .int()
  .min(0, "Free-delivery amount can't be negative.")
  .max(MAX_FREE_DELIVERY_ABOVE_PAISE, "Free delivery can start at most at ₹1,00,000.");
export const preparationMinutesSchema = z
  .number()
  .int("Preparation time is a whole number of minutes.")
  .min(MIN_PREPARATION_MINUTES, `Preparation time is at least ${MIN_PREPARATION_MINUTES} minutes.`)
  .max(MAX_PREPARATION_MINUTES, `Preparation time is at most ${MAX_PREPARATION_MINUTES} minutes.`);

/* --------------------------------------------------------------- text */

/** Required text, outer spaces removed before its length is checked: "      " is empty (TC-FLD-037). */
export function requiredText(min: number, max: number) {
  return z.string().trim().min(min).max(max);
}

/** Optional text, trimmed; only spaces reads as no value (null). */
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === "" ? null : v));
}

/* ------------------------------------------------------------- images */

/**
 * A logo or shop photo: an https address, or one of the site's own uploads
 * ("/api/images/<uuid>"). Rendered as an <img src>, so "javascript:" and other
 * schemes are refused (TC-FLD-056).
 */
export function isShopImageUrl(value: string): boolean {
  if (/^\/api\/images\/[0-9a-f-]{36}$/i.test(value)) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export const shopImageUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine(isShopImageUrl, "Use an https:// image address or an uploaded image.");

/* ------------------------------------------------------ opening hours */

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * "Shop time": one entry per weekday (0 = Sunday), each at most once, times
 * "HH:MM" from 00:00 to 23:59. An open day needs different opening and closing
 * times; a close before the open runs past midnight (lib/shop-hours.ts).
 * "25:00", "morning" and open = close used to be saved (TC-FLD-052).
 */
export const openingHoursSchema = z
  .array(
    z.object({
      day: z.number().int().min(0).max(6),
      open: z.string().regex(HH_MM, "Use a time from 00:00 to 23:59 (HH:MM)."),
      close: z.string().regex(HH_MM, "Use a time from 00:00 to 23:59 (HH:MM)."),
      closed: z.boolean().optional(),
    }),
  )
  .max(7)
  .superRefine((hours, ctx) => {
    const seen = new Set<number>();
    hours.forEach((h, index) => {
      if (seen.has(h.day)) {
        ctx.addIssue({ code: "custom", path: [index, "day"], message: "Each day can appear only once." });
      }
      seen.add(h.day);
      if (!h.closed && h.open === h.close) {
        ctx.addIssue({
          code: "custom",
          path: [index, "close"],
          message: "Opening and closing times must differ (mark the day closed instead).",
        });
      }
    });
  });

export type OpeningHoursInput = z.infer<typeof openingHoursSchema>;
