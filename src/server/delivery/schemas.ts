/** Request schemas shared by the delivery-management API routes (docs/hdms-2026-11). */
import { z } from "zod";

import { COMMERCIAL_MODELS } from "@/server/db/hdms-schema";

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour).");
const paise = z.number().int().min(0).max(10_000_000);

export const zoneSchema = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9-]+$/, "Letters, digits and dashes only."),
  name: z.string().trim().min(2).max(80),
  city: z.string().trim().min(2).max(60),
  centerLat: z.number().min(6).max(38),
  centerLng: z.number().min(68).max(98),
  radiusM: z.number().int().min(100).max(50_000),
  polygon: z.array(z.tuple([z.number(), z.number()])).min(3).max(200).nullable().optional(),
  maxDeliveryKm: z.number().min(0.5).max(100),
});

export const pricingRuleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  zoneId: z.string().uuid().nullable(),
  active: z.boolean(),
  priority: z.number().int().min(1).max(10_000),
  commercialModel: z.enum(COMMERCIAL_MODELS),
  minFeePaise: paise,
  baseKm: z.number().min(0).max(100),
  perKmPaise: paise,
  freeWeightGrams: z.number().int().min(0).max(1_000_000),
  perKgPaise: paise,
  expressSurchargePaise: paise,
  peakSurchargePaise: paise,
  peakWindows: z.array(z.object({ from: clock, to: clock })).max(6),
  freeAbovePaise: paise.nullable(),
  shopSharePercent: z.number().int().min(0).max(100),
  gokesariSubsidyPaise: paise,
  promoDiscountPaise: paise,
  maxFeePaise: paise.nullable(),
  validFrom: z.coerce.date().nullable(),
  validUntil: z.coerce.date().nullable(),
});

export const productDeliverySchema = z.object({
  perishable: z.boolean(),
  fragile: z.boolean(),
  temperatureSensitive: z.boolean(),
  refrigerationRequired: z.boolean(),
  maxDeliveryMinutes: z.number().int().min(5).max(1440).nullable(),
  weightGrams: z.number().int().min(0).max(1_000_000).nullable(),
  lengthMm: z.number().int().min(0).max(10_000).nullable(),
  widthMm: z.number().int().min(0).max(10_000).nullable(),
  heightMm: z.number().int().min(0).max(10_000).nullable(),
  packagingNote: z.string().max(300).nullable(),
});
