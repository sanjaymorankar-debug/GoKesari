/** Shared request schemas and guards for the Puja Samagri API routes (docs/puja-samagri-2026-11). */
import { z } from "zod";

import { PUJA_FESTIVALS } from "@/lib/puja";
import { requireRole } from "@/server/authz/guards";

/** Catalogue staff: operators and admins (brief §6). */
export async function requirePujaStaff() {
  return requireRole("OPERATOR", "ADMIN");
}

const boolish = z
  .union([z.boolean(), z.enum(["1", "0", "true", "false", "on", ""])])
  .optional()
  .transform((v) => v === true || v === "1" || v === "true" || v === "on");

export const catalogueQuerySchema = z.object({
  categoryId: z.string().uuid().optional(),
  typeId: z.string().uuid().optional(),
  festival: z.string().max(40).optional(),
  kind: z.enum(["loose", "packed"]).optional(),
  q: z.string().trim().max(80).optional(),
  notListed: boolish,
  includeRetired: boolish,
  taxToVerify: boolish,
  limit: z.coerce.number().int().min(1).max(600).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
});

export const paise = z.number().int().min(0).max(100_000_000);

export const festivalSchema = z
  .object({
    festivalKey: z.enum(PUJA_FESTIVALS.map((f) => f.key) as [string, ...string[]]),
    title: z.string().trim().min(3).max(80),
    titleHi: z.string().trim().max(80).nullish(),
    titleMr: z.string().trim().max(80).nullish(),
    subtitle: z.string().trim().max(160).nullish(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    active: z.boolean().optional(),
    showOnHome: z.boolean().optional(),
  })
  .refine((v) => v.endsAt > v.startsAt, { message: "The end must be after the start.", path: ["endsAt"] });
