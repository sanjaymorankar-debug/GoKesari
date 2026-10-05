import { z } from "zod";

export const shopOfferSchema = z.object({
  title: z.string().trim().min(3).max(80),
  targetType: z.enum(["PRODUCT", "CATEGORY"]),
  shopProductId: z.string().uuid().nullish(),
  categoryId: z.string().uuid().nullish(),
  discountType: z.enum(["PERCENT", "FLAT"]),
  percent: z.number().int().min(1).max(90).nullish(),
  flatPaise: z.number().int().min(1).max(10_000_000).nullish(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  active: z.boolean().optional(),
});
