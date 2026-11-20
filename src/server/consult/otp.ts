/**
 * Consultant appointments: the completion code (as with the delivery code).
 * The customer reads a 4-digit code from their booking page and tells the
 * consultant, who enters it to mark the appointment completed.
 *
 * The code is never stored: it is HMAC-SHA256(AUTH_SECRET, booking id + a
 * per-booking salt) reduced to 4 digits, worked out again when the customer
 * opens the booking and when the consultant enters it. A copy of the database
 * alone therefore cannot produce or check a code; a new salt makes a new code.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";

export const COMPLETION_CODE_LENGTH = 4;

export function newOtpSalt(): string {
  return randomBytes(8).toString("hex");
}

export function completionCode(bookingId: string, salt: string): string {
  const mac = createHmac("sha256", getEnv().AUTH_SECRET).update(`consult-otp:${salt}:${bookingId}`).digest();
  const n = mac.readUInt32BE(0) % 10 ** COMPLETION_CODE_LENGTH;
  return String(n).padStart(COMPLETION_CODE_LENGTH, "0");
}

export function completionCodeMatches(bookingId: string, salt: string | null, entered: string): boolean {
  if (!salt) return false;
  const clean = entered.replace(/\D/g, "");
  if (clean.length !== COMPLETION_CODE_LENGTH) return false;
  const want = Buffer.from(completionCode(bookingId, salt));
  const got = Buffer.from(clean);
  return want.length === got.length && timingSafeEqual(want, got);
}
