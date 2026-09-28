/** Request schemas shared by the shop marketing routes (GS-052/053). */
import { z } from "zod";

export const rulesSchema = z
  .object({
    pincodes: z.array(z.string()).max(50).optional(),
    societyIds: z.array(z.string().uuid()).max(50).optional(),
    minOrders: z.number().int().optional(),
    orderedWithinDays: z.number().int().optional(),
    lapsedForDays: z.number().int().optional(),
    minSpendPaise: z.number().int().optional(),
  })
  .strict();

export const campaignSchema = z.object({
  segmentId: z.string().uuid(),
  title: z.string().max(80),
  message: z.string().max(500),
  offerText: z.string().max(120).nullish(),
  maxRecipients: z.number().int(),
  attributionDays: z.number().int().optional(),
});
