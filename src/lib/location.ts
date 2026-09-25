/**
 * The customer's chosen delivery location (GS-004) — shared shape for the
 * server (discovery filtering, see services/serviceability.ts) and the
 * browser (the location picker).
 *
 * Stored in an httpOnly cookie so an anonymous visitor can browse "shops that
 * deliver to me" before signing in. Holds no identity: a label, a PIN code
 * and optional coordinates rounded to ~11 m (4 decimals) — enough for a
 * radius check, not a precise home position.
 */
import { z } from "zod";

export const LOCATION_COOKIE = "gk_location";
export const LOCATION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export const customerLocationSchema = z
  .object({
    /** What the customer sees, e.g. "Home — Kothrud, 411038" or "PIN 411001". */
    label: z.string().min(1).max(120),
    pincode: z.string().regex(/^\d{6}$/).nullable(),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    source: z.enum(["ADDRESS", "DEVICE", "PINCODE"]),
    /** Set when chosen from a saved address — lets checkout preselect it. */
    addressId: z.string().uuid().nullable(),
    /** The address's society, when it is inside one (society-aware discovery). */
    societyId: z.string().uuid().nullable().default(null),
  })
  .refine((l) => l.pincode != null || (l.latitude != null && l.longitude != null), {
    message: "A location needs a PIN code or coordinates.",
  });

export type CustomerLocation = z.infer<typeof customerLocationSchema>;

export function roundCoordinate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function serializeLocation(location: CustomerLocation): string {
  return JSON.stringify(location);
}

/** Never throws: a tampered or stale cookie just means "no location chosen". */
export function parseLocation(raw: string | undefined | null): CustomerLocation | null {
  if (!raw) return null;
  try {
    const parsed = customerLocationSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
