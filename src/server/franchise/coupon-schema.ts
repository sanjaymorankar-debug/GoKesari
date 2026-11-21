/** The admin coupon form (§5.7) as a request schema: money in paise, % in basis points, dates as ISO (entered in IST). */
import { z } from "zod";

import { ZONE_TIERS } from "@/lib/franchise";

export const couponInputSchema = z.object({
  code: z.string().trim().min(3).max(30),
  name: z.string().trim().min(1).max(100),
  note: z.string().trim().max(500).nullish(),
  discountType: z.enum(["PERCENT", "FLAT"]),
  percentBp: z.number().int().min(1).max(10_000).nullish(),
  flatPaise: z.number().int().positive().max(1_000_000_000).nullish(),
  maxDiscountPaise: z.number().int().positive().max(1_000_000_000).nullish(),
  scope: z.union([z.object({ all: z.literal(true) }), z.object({ all: z.literal(false).optional(), zoneSets: z.array(z.string()).max(20).optional(), tiers: z.array(z.enum(ZONE_TIERS)).max(3).optional(), zones: z.array(z.string()).max(200).optional() })]),
  appliesOn: z.enum(["NEW", "RENEWAL", "BOTH"]),
  visibility: z.enum(["PUBLIC", "PRIVATE"]),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  totalLimit: z.number().int().positive().nullish(),
  perDealerLimit: z.number().int().positive().nullish(),
  minCartPaise: z.number().int().min(0).nullish(),
  firstPurchaseOnly: z.boolean().optional(),
  launchOnly: z.boolean().optional(),
});
