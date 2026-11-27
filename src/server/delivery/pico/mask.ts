/**
 * Masking for everything about Pico that is written to a log or table (DPDP Act 2023: keep only what is needed).
 * Phone numbers keep their last 2 digits, OTPs, keys and tokens are removed, names and street address lines are
 * removed (city, state and PIN code stay for support), coordinates are rounded to about 100 m.
 */
const SECRET_KEYS = /authorization|apikey|api_key|clientkey|client_key|secret|token|password|otp/i;
const PHONE_KEYS = /phone|mobile|contactnum|contactnumber/i;
// unitName is the customer's own name on the delivery side, so it is masked everywhere.
const NAME_KEYS = /^(representativepersonname|unitname|name|customername|recipientname)$/i;
const ADDRESS_LINE_KEYS = /^addressline\d$/i;
const COORD_KEYS = /^(lat|lng|latitude|longitude|deliverylat|deliverylng|pickuplat|pickuplng)$/i;

export function maskPhoneDigits(value: unknown): string | null {
  if (value == null || value === "") return null;
  const digits = String(value).replace(/\D/g, "");
  if (digits.length < 4) return "**";
  return `${"*".repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}`;
}

/** Deep copy with personal and secret fields masked. Safe on any JSON value. */
export function maskForLog(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[deep]";
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => maskForLog(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.test(k)) out[k] = v == null ? v : "[redacted]";
    else if (PHONE_KEYS.test(k) && (typeof v === "string" || typeof v === "number")) out[k] = maskPhoneDigits(v);
    else if (NAME_KEYS.test(k) && typeof v === "string") out[k] = v ? "[name]" : v;
    else if (ADDRESS_LINE_KEYS.test(k) && typeof v === "string") out[k] = v ? "[address]" : v;
    else if (COORD_KEYS.test(k) && typeof v === "number") out[k] = Math.round(v * 1000) / 1000;
    else out[k] = maskForLog(v, depth + 1);
  }
  return out;
}

/** Removes the query string's secrets from an endpoint before it is logged (clientKey). */
export function maskEndpoint(pathWithQuery: string): string {
  return pathWithQuery.replace(/([?&]clientKey=)[^&]*/i, "$1[redacted]");
}
