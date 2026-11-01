/**
 * Referral code format (owner decision, 30 Oct 2026): at most 8 characters,
 * letters and digits only. Codes GoKesari generates are exactly 8 characters
 * from an alphabet without 0/O and 1/I/L, so they are easy to read aloud and
 * type (31^8 ≈ 850 billion codes). Codes made before this rule (e.g.
 * GKS-MH-PUN-7K4Q9X, PUNE-PARTNER-1) keep working; only new codes follow it.
 * No secrets here — client bundles import this file.
 */
import type { ZodString } from "zod";

export const REFERRAL_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const REFERRAL_CODE_LENGTH = 8;
/** A code typed by staff: 4 to 8 letters and digits. */
export const REFERRAL_CODE_MIN_LENGTH = 4;

const TYPED = new RegExp(`^[A-Z0-9]{${REFERRAL_CODE_MIN_LENGTH},${REFERRAL_CODE_LENGTH}}$`);

/** True when a new (upper-cased) code may be created as typed. */
export function isValidNewReferralCode(code: string): boolean {
  return TYPED.test(code);
}

/** What a generated code looks like. */
export function generatedReferralCodePattern(): RegExp {
  return new RegExp(`^[${REFERRAL_CODE_ALPHABET}]{${REFERRAL_CODE_LENGTH}}$`);
}

/** An expiry date (YYYY-MM-DD) chosen by staff: today or later (UTC date). */
export function notPast(schema: ZodString) {
  return schema.refine((d) => d >= new Date().toISOString().slice(0, 10), "The expiry date is in the past.");
}
