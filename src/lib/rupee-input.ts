/**
 * A rupee amount typed into a staff money form, read without rounding
 * (TC-FLD-099: "10.555" was refunded as ₹10.56). At most two decimals — the
 * paise — or the amount is refused with a message; the API refuses fractional
 * paise as well. Client-safe.
 */
export type RupeeInput = { ok: true; paise: number } | { ok: false; error: string } | { ok: "empty" };

export const RUPEE_DECIMALS_MESSAGE = "Enter the amount in rupees with at most 2 decimals (paise), e.g. 70.50.";

export function parseRupeeInput(text: string, options: { allowNegative?: boolean } = {}): RupeeInput {
  const value = text.trim();
  if (!value) return { ok: "empty" };
  const match = (options.allowNegative ? /^(-?)(\d+)(?:\.(\d{1,2}))?$/ : /^()(\d+)(?:\.(\d{1,2}))?$/).exec(value);
  if (!match) {
    return {
      ok: false,
      error: /^-?\d*\.\d{3,}$/.test(value) ? RUPEE_DECIMALS_MESSAGE : "Enter the amount in rupees, e.g. 70 or 70.50.",
    };
  }
  // Built from the digits, never through floating point.
  const paise = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(paise)) return { ok: false, error: "That amount is too large." };
  return { ok: true, paise: match[1] === "-" && paise !== 0 ? -paise : paise };
}
