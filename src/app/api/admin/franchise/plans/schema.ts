/** Body of a franchise plan (Admin → Franchise → Plans). Money in paise; null price = the zone's tier fee. */
import { z } from "zod";

export const planInputSchema = z.object({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(500).optional(),
  durationMonths: z.number().int().min(1).max(120),
  pricePerZonePaise: z.number().int().min(100).max(1_000_000_000).nullable(),
  gstExtra: z.boolean(),
  isLaunchOffer: z.boolean(),
  active: z.boolean(),
  sortOrder: z.number().int().min(-1000).max(1000),
});
