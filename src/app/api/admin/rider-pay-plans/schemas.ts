/** Request bodies of the Rider pay plans admin API (docs/rider-app-v2-2026-11). Amounts in paise, distances in metres. */
import { z } from "zod";

import { PAY_PLAN_SCOPES, SURGE_REASONS } from "@/server/db/schema";

const paise = z.number().int().min(0).max(10_000_000);
const metres = z.number().int().min(0).max(1_000_000);

export const slabSchema = z.object({
  fromM: metres,
  toM: metres.nullable(),
  ratePaise: paise,
});

export const planSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopeType: z.enum(PAY_PLAN_SCOPES),
  city: z.string().trim().max(80).nullish(),
  zoneId: z.string().uuid().nullish(),
  baseFeePaise: paise,
  baseIncludedM: metres,
  slabs: z.array(slabSchema).min(1).max(20),
  freeFirstMileM: metres,
  firstMileRatePaise: paise,
  firstMileCapPaise: paise,
  freeWaitMin: z.number().int().min(0).max(600),
  waitRatePaise: paise,
  waitCapPaise: paise,
  extraDropFeePaise: paise,
  longDistanceM: metres.nullable(),
  longDistanceBonusPaise: paise,
  minGuaranteePaise: paise,
  maxPerOrderPaise: paise.nullable(),
  rerouteTolerancePct: z.number().int().min(0).max(100),
  note: z.string().trim().max(500).nullish(),
});

export const cloneSchema = z.object({ asNewPlan: z.boolean().optional() });

export const simulateSchema = z.object({ days: z.union([z.literal(7), z.literal(30)]) });

export const publishSchema = z.object({
  note: z.string().trim().min(5, "Write a short note saying why the pay is changing.").max(500),
  effectiveFrom: z.string().datetime().nullish(),
});

export const surgeSchema = z
  .object({
    city: z.string().trim().max(80).nullish(),
    zoneId: z.string().uuid().nullish(),
    /** 13000 = ×1.3. */
    multiplierBp: z.number().int().min(10000).max(30000),
    flatPaise: paise,
    reason: z.enum(SURGE_REASONS),
    note: z.string().trim().max(200).nullish(),
    startsAt: z.string().datetime().nullish(),
    endsAt: z.string().datetime(),
  })
  .refine((s) => Boolean(s.zoneId || s.city?.trim()), { message: "Choose a city or a zone.", path: ["city"] });

export const calculateSchema = z.object({
  planId: z.string().uuid().nullish(),
  city: z.string().trim().max(80).nullish(),
  zoneId: z.string().uuid().nullish(),
  /** D: shop → customer, km. */
  legKm: z.number().min(0).max(200),
  /** P: rider → shop, km. */
  firstMileKm: z.number().min(0).max(200),
  waitMin: z.number().min(0).max(600),
  extraLegsKm: z.array(z.number().min(0).max(200)).max(10).optional(),
  at: z.string().datetime().nullish(),
});
