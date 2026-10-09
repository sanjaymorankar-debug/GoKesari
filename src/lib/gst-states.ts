/**
 * GST state / union-territory codes (the first two digits of a GSTIN and the
 * "place of supply" code in GST returns and e-invoices). Module 2,
 * docs/three-modules-2026-10. Dependency-free.
 */
export interface GstState {
  /** Two-digit GST code, e.g. "27". */
  code: string;
  /** Two-letter abbreviation used elsewhere in the app, e.g. "MH". */
  alpha: string;
  name: string;
}

export const GST_STATES: readonly GstState[] = [
  { code: "01", alpha: "JK", name: "Jammu and Kashmir" },
  { code: "02", alpha: "HP", name: "Himachal Pradesh" },
  { code: "03", alpha: "PB", name: "Punjab" },
  { code: "04", alpha: "CH", name: "Chandigarh" },
  { code: "05", alpha: "UK", name: "Uttarakhand" },
  { code: "06", alpha: "HR", name: "Haryana" },
  { code: "07", alpha: "DL", name: "Delhi" },
  { code: "08", alpha: "RJ", name: "Rajasthan" },
  { code: "09", alpha: "UP", name: "Uttar Pradesh" },
  { code: "10", alpha: "BR", name: "Bihar" },
  { code: "11", alpha: "SK", name: "Sikkim" },
  { code: "12", alpha: "AR", name: "Arunachal Pradesh" },
  { code: "13", alpha: "NL", name: "Nagaland" },
  { code: "14", alpha: "MN", name: "Manipur" },
  { code: "15", alpha: "MZ", name: "Mizoram" },
  { code: "16", alpha: "TR", name: "Tripura" },
  { code: "17", alpha: "ML", name: "Meghalaya" },
  { code: "18", alpha: "AS", name: "Assam" },
  { code: "19", alpha: "WB", name: "West Bengal" },
  { code: "20", alpha: "JH", name: "Jharkhand" },
  { code: "21", alpha: "OD", name: "Odisha" },
  { code: "22", alpha: "CG", name: "Chhattisgarh" },
  { code: "23", alpha: "MP", name: "Madhya Pradesh" },
  { code: "24", alpha: "GJ", name: "Gujarat" },
  { code: "26", alpha: "DN", name: "Dadra and Nagar Haveli and Daman and Diu" },
  { code: "27", alpha: "MH", name: "Maharashtra" },
  { code: "29", alpha: "KA", name: "Karnataka" },
  { code: "30", alpha: "GA", name: "Goa" },
  { code: "31", alpha: "LD", name: "Lakshadweep" },
  { code: "32", alpha: "KL", name: "Kerala" },
  { code: "33", alpha: "TN", name: "Tamil Nadu" },
  { code: "34", alpha: "PY", name: "Puducherry" },
  { code: "35", alpha: "AN", name: "Andaman and Nicobar Islands" },
  { code: "36", alpha: "TS", name: "Telangana" },
  { code: "37", alpha: "AP", name: "Andhra Pradesh" },
  { code: "38", alpha: "LA", name: "Ladakh" },
  { code: "97", alpha: "OT", name: "Other Territory" },
];

const byCode = new Map(GST_STATES.map((s) => [s.code, s]));
const byAlpha = new Map(GST_STATES.map((s) => [s.alpha, s]));
const byName = new Map(GST_STATES.map((s) => [s.name.toUpperCase(), s]));
// Older codes and spellings still seen on addresses and GSTINs.
byCode.set("25", byCode.get("26")!);
byCode.set("28", byCode.get("37")!);
byAlpha.set("DD", byCode.get("26")!);
byAlpha.set("TG", byCode.get("36")!);
byAlpha.set("OR", byCode.get("21")!);
byName.set("ORISSA", byCode.get("21")!);
byName.set("PONDICHERRY", byCode.get("34")!);
byName.set("NEW DELHI", byCode.get("07")!);

/** Resolves "27", "MH", "Maharashtra" (any case) or a GSTIN to a state; null when unknown. */
export function gstState(raw: string | null | undefined): GstState | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (/^\d{2}[A-Z0-9]{13}$/.test(s)) return byCode.get(s.slice(0, 2)) ?? null;
  if (/^\d{1,2}$/.test(s)) return byCode.get(s.padStart(2, "0")) ?? null;
  if (/^[A-Z]{2}$/.test(s)) return byAlpha.get(s) ?? null;
  return byName.get(s.replace(/\s+/g, " ")) ?? null;
}

/** "Maharashtra (27)" — the form an invoice shows for place of supply. */
export function stateLabel(raw: string | null | undefined): string | null {
  const state = gstState(raw);
  return state ? `${state.name} (${state.code})` : null;
}

/** Standard 15-character GSTIN shape and check digit (mod-36 checksum). */
export function isValidGstin(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const g = raw.trim().toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = chars.indexOf(g[i]);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  const check = chars[(36 - (sum % 36)) % 36];
  return g[14] === check;
}
