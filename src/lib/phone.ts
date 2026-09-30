/**
 * Mobile-number handling for mobile login. Numbers are stored and compared in
 * E.164 form ("+919876543210"); the caller supplies a country calling code and
 * the national number separately, as the sign-in form does.
 */

export interface CountryCode {
  code: string; // calling code with '+'
  label: string;
  /** National-number pattern; falls back to generic 6–14 digits. */
  national?: RegExp;
}

export const COUNTRY_CODES: readonly CountryCode[] = [
  { code: "+91", label: "India (+91)", national: /^[6-9]\d{9}$/ },
  { code: "+1", label: "US / Canada (+1)", national: /^[2-9]\d{9}$/ },
  { code: "+44", label: "United Kingdom (+44)", national: /^\d{10}$/ },
  { code: "+971", label: "UAE (+971)", national: /^\d{9}$/ },
  { code: "+65", label: "Singapore (+65)", national: /^[3689]\d{7}$/ },
  { code: "+61", label: "Australia (+61)", national: /^\d{9}$/ },
  { code: "+977", label: "Nepal (+977)", national: /^\d{10}$/ },
  { code: "+880", label: "Bangladesh (+880)", national: /^\d{10}$/ },
  { code: "+94", label: "Sri Lanka (+94)", national: /^\d{9}$/ },
];

export type PhoneParse =
  | { ok: true; e164: string; national: string; countryCode: string }
  | { ok: false; error: string };

export function parsePhone(countryCode: string, mobile: string): PhoneParse {
  const cc = COUNTRY_CODES.find((c) => c.code === countryCode.trim());
  if (!cc) return { ok: false, error: "Choose a supported country code." };
  // Tolerate spaces, dashes and a leading trunk 0 — nothing else.
  let digits = mobile.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) return { ok: false, error: "Enter digits only." };
  if (digits.startsWith("0")) digits = digits.slice(1);
  const pattern = cc.national ?? /^\d{6,14}$/;
  if (!pattern.test(digits)) return { ok: false, error: "Enter a valid mobile number for that country." };
  return { ok: true, e164: `${cc.code}${digits}`, national: digits, countryCode: cc.code };
}

/** "+91 ******3210" — for display in audit trails and admin views, never for enumeration-sensitive replies. */
export function maskPhone(e164: string): string {
  if (e164.length <= 6) return "******";
  return `${e164.slice(0, 3)} ${"*".repeat(Math.max(e164.length - 7, 4))}${e164.slice(-4)}`;
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}${"*".repeat(Math.max(local.length - 1, 2))}@${domain}`;
}
