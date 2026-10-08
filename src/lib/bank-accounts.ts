/**
 * Bank accounts (docs/four-features-2026-10, feature 3) — client-safe format
 * checks and masking, shared by the form and the server.
 */

export type BankMethod = "BANK_ACCOUNT" | "UPI";

export const VERIFICATION_METHODS = ["UPI", "DEBIT_CARD", "CREDIT_CARD", "NET_BANKING"] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export const VERIFICATION_METHOD_LABELS: Record<VerificationMethod, string> = {
  UPI: "UPI",
  DEBIT_CARD: "Debit card",
  CREDIT_CARD: "Credit card",
  NET_BANKING: "Net banking",
};

export const BANK_STATUS_LABELS = {
  PENDING: "Not verified yet",
  VERIFIED: "Verified",
  FAILED: "Verification failed",
} as const;

type Check<T> = { ok: true; value: T } | { ok: false; error: string };

export function checkHolderName(raw: string): Check<string> {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length < 2 || value.length > 100) return { ok: false, error: "Enter the account holder's name as the bank has it." };
  if (!/^[A-Za-z][A-Za-z .'&-]*$/.test(value)) return { ok: false, error: "Use letters, spaces and . ' & - only." };
  return { ok: true, value };
}

/** Indian bank account numbers are 9 to 18 digits. */
export function checkAccountNumber(raw: string): Check<string> {
  const value = raw.replace(/[\s-]/g, "");
  if (!/^\d{9,18}$/.test(value)) return { ok: false, error: "An account number is 9 to 18 digits." };
  if (/^0+$/.test(value)) return { ok: false, error: "Check the account number." };
  return { ok: true, value };
}

/** IFSC: 4 letters (bank), 0, then 6 letters or digits (branch). */
export function checkIfsc(raw: string): Check<string> {
  const value = raw.trim().toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(value)) return { ok: false, error: "An IFSC is 11 characters, like SBIN0001234 (the 5th is a zero)." };
  return { ok: true, value };
}

export function checkUpiId(raw: string): Check<string> {
  const value = raw.trim().toLowerCase();
  if (!/^[a-z0-9.\-_]{2,256}@[a-z][a-z0-9]{1,63}$/.test(value)) return { ok: false, error: "A UPI ID looks like name@bank." };
  return { ok: true, value };
}

/** "••••1234". */
export function maskAccountNumber(last4: string | null): string | null {
  return last4 ? `••••${last4}` : null;
}

/** "ra••••@okicici". */
export function maskUpiId(upi: string): string {
  const [local, handle] = upi.split("@");
  return `${local.slice(0, 2)}${"•".repeat(Math.max(local.length - 2, 2))}@${handle}`;
}
