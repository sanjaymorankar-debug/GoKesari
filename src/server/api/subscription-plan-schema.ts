/** The plan a shop submits (docs/subscription-plans-2026-11) — shared by the create and update routes. */
import { z } from "zod";

import { MAX_PRICE_PAISE, MIN_PRICE_PAISE, PRICE_MAX_MESSAGE, PRICE_MIN_MESSAGE } from "@/lib/price-rules";
import { PLAN_KINDS, PLAN_MAX_LEAD_DAYS, PLAN_MAX_TERM_DAYS, PLAN_SLOTS } from "@/lib/subscription-plans";

export const planInputSchema = z.object({
  shopProductId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  description: z.string().max(500).nullish(),
  kind: z.enum(PLAN_KINDS),
  slot: z.enum(PLAN_SLOTS),
  slotWindow: z.string().max(40).nullish(),
  serviceDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  allowedFrequencies: z.array(z.enum(["DAILY", "WEEKLY", "MONTHLY"])).min(1).max(3),
  pricePaise: z.number().int().min(MIN_PRICE_PAISE, PRICE_MIN_MESSAGE).max(MAX_PRICE_PAISE, PRICE_MAX_MESSAGE).nullish(),
  termDays: z.array(z.number().int().min(1).max(PLAN_MAX_TERM_DAYS)).max(6).default([]),
  leadDays: z.number().int().min(0).max(PLAN_MAX_LEAD_DAYS).default(1),
  isActive: z.boolean().default(true),
});
