/**
 * Mobile and email rules shared by the browser forms and the server, so both
 * sides accept and reject exactly the same input.
 */
import { parsePhone } from "./phone";

export const INDIAN_MOBILE_HINT = "Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9.";
export const EMAIL_HINT = "Enter a valid email address, e.g. name@example.com.";

export type MobileParse = { ok: true; e164: string; national: string } | { ok: false; error: string };

/** Accepts "98765 43210", "098765-43210", "+91 9876543210" or "919876543210". */
export function parseIndianMobile(input: string): MobileParse {
  let digits = input.replace(/[\s()-]/g, "");
  if (digits.startsWith("+91")) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  const parsed = parsePhone("+91", digits);
  if (!parsed.ok) return { ok: false, error: INDIAN_MOBILE_HINT };
  return { ok: true, e164: parsed.e164, national: parsed.national };
}

/**
 * A phone someone can be called on: an Indian mobile, or a landline with its
 * STD code (10 digits after +91 or the trunk 0, e.g. "020 2612 3456").
 * TC-FLD-105: a society's gate contact "123456" was accepted.
 */
export function isIndianPhone(input: string): boolean {
  if (parseIndianMobile(input).ok) return true;
  let digits = input.trim().replace(/[\s()-]/g, "");
  if (digits.startsWith("+91")) digits = digits.slice(3);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  return /^[1-9]\d{9}$/.test(digits);
}

/**
 * What a 10-digit mobile field keeps from typed or pasted text: the national
 * number. A leading "+91" or a 12-digit "91…" is the country code, not the
 * first digits of the number (TC-LOC-009: "+91 98765 43210" kept "9198765432").
 */
export function mobileFieldDigits(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (value.trim().startsWith("+91") || (digits.length > 10 && digits.startsWith("91"))) digits = digits.slice(2);
  return digits.slice(0, 10);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export function isValidEmail(input: string): boolean {
  const email = normalizeEmail(input);
  return email.length <= 254 && EMAIL_PATTERN.test(email);
}

/** "sa***@gmail.com" — shown on the code screen so the user knows which inbox to open. */
export function maskEmailAddress(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, Math.min(2, Math.max(local.length - 1, 1)))}***@${domain}`;
}

/** "+91 98765 43210" */
export function formatIndianMobile(e164: string): string {
  const national = e164.startsWith("+91") ? e164.slice(3) : e164;
  return national.length === 10 ? `+91 ${national.slice(0, 5)} ${national.slice(5)}` : e164;
}
