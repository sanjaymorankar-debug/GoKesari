import { z } from "zod";

const paise = z.number().int().min(0).max(100_000_000);

export const registrationFeeCouponSchema = z.object({
  code: z.string().trim().min(3).max(32),
  description: z.string().max(200).nullish(),
  discountType: z.enum(["FLAT", "PERCENT"]),
  flatPaise: paise.nullish(),
  percent: z.number().int().min(1).max(100).nullish(),
  maxDiscountPaise: paise.nullish(),
  startsAt: z.coerce.date().nullish(),
  expiresAt: z.coerce.date().nullish(),
  usageLimit: z.number().int().min(1).nullish(),
  perOwnerLimit: z.number().int().min(1).nullish(),
  active: z.boolean().optional(),
});
