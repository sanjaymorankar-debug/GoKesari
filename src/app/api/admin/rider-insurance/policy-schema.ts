/** The admin's policy form, shared by the create and edit routes. Covers come in rupees. */
import { z } from "zod";

import { rupeesToPaise } from "@/lib/money";
import type { PolicyInput } from "@/server/services/rider-insurance";

const rupees = z.number().min(0).max(100_000_000);

export const policySchema = z.object({
  insurer: z.string().max(200),
  policyNumber: z.string().max(100),
  healthCoverRupees: rupees,
  accidentCoverRupees: rupees,
  opdCoverRupees: rupees,
  minDeliveries: z.number().int(),
  lookbackDays: z.number().int(),
  validFrom: z.string().max(10),
  validTo: z.string().max(10),
  hospitalsUrl: z.string().max(500).nullish(),
  hospitals: z
    .array(
      z.object({
        name: z.string().max(200),
        city: z.string().max(100),
        address: z.string().max(400).optional(),
        phone: z.string().max(40).optional(),
      }),
    )
    .max(500)
    .default([]),
  claimHelp: z.string().max(4000).nullish(),
  isActive: z.boolean(),
});

export function toPolicyInput(body: z.infer<typeof policySchema>): PolicyInput {
  return {
    insurer: body.insurer,
    policyNumber: body.policyNumber,
    healthCoverPaise: rupeesToPaise(body.healthCoverRupees),
    accidentCoverPaise: rupeesToPaise(body.accidentCoverRupees),
    opdCoverPaise: rupeesToPaise(body.opdCoverRupees),
    minDeliveries: body.minDeliveries,
    lookbackDays: body.lookbackDays,
    validFrom: body.validFrom,
    validTo: body.validTo,
    hospitalsUrl: body.hospitalsUrl ?? null,
    hospitals: body.hospitals,
    claimHelp: body.claimHelp ?? null,
    isActive: body.isActive,
  };
}
