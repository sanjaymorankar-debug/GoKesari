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
