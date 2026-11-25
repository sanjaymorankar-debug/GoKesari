/**
 * Masking for identity numbers (docs/identity-verification-2026-11). Client-safe.
 *
 *  - maskAadhaarLast4 / maskPanLast4: the only forms ever stored or shown.
 *  - redactIdentityNumbers: replaces any Aadhaar-like 12-digit run (spaces or
 *    hyphens allowed between groups), any other run of 9+ digits and any PAN
 *    in free text with its masked form. Used on every log line and error
 *    message the identity flow writes, and on the server's unhandled-error
 *    log (lib/errors.ts), so a number pasted into the wrong field never lands
 *    in a log in full.
 */

/** "XXXX XXXX 1234" from the last four digits of whatever is given. */
export function maskAadhaarLast4(digitsOrLast4: string): string {
  const last4 = digitsOrLast4.replace(/\D/g, "").slice(-4);
  return `XXXX XXXX ${last4.padStart(4, "X")}`;
}

/** "XXXXXX234F": a PAN with only its last four characters shown. */
export function maskPanLast4(pan: string): string {
  const clean = pan.replace(/\s/g, "").toUpperCase();
  return `XXXXXX${clean.slice(-4)}`;
}

/** 12 digits in groups of 4-4-4 with optional space / hyphen, or 12 in a row. */
const AADHAAR_LIKE = /(?<![\d])(\d{4})[\s-]?(\d{4})[\s-]?(\d{4})(?![\d])/g;
/** Any other long digit run (16-digit VIDs, account numbers, a 12-digit number glued to others). */
const LONG_DIGITS = /\d{9,}/g;
const PAN_LIKE = /(?<![A-Za-z0-9])([A-Za-z]{5})(\d{4})([A-Za-z])(?![A-Za-z0-9])/g;

export function redactIdentityNumbers(text: string): string {
  return text
    .replace(AADHAAR_LIKE, (_m, _a, _b, c: string) => `XXXX XXXX ${c}`)
    .replace(LONG_DIGITS, (m) => `${"X".repeat(m.length - 4)}${m.slice(-4)}`)
    .replace(PAN_LIKE, (_m, _a, digits: string, last: string) => `XXXXXX${digits.slice(1)}${last}`.toUpperCase());
}

/** True when the text still holds 5+ digits in a row — what a stored masked id must never contain. */
export function containsUnmaskedNumber(text: string): boolean {
  return /\d{5,}/.test(text.replace(/[\s-]/g, ""));
}

/** An error or anything thrown, as one masked line for a log. */
export function redactForLog(error: unknown): string {
  if (error instanceof Error) {
    const head = `${error.name}: ${error.message}`;
    const stack = error.stack ? error.stack.split("\n").slice(1).join("\n") : "";
    return redactIdentityNumbers(stack ? `${head}\n${stack}` : head);
  }
  try {
    return redactIdentityNumbers(typeof error === "string" ? error : JSON.stringify(error));
  } catch {
    return "[unprintable error]";
  }
}
