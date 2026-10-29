/**
 * India's 28 states and 8 union territories (docs/dealer-programme, all-India).
 * The codes are the two-letter ones used across the app (lib/pincode-state.ts,
 * GSTIN state codes): they are each state's area code in `geo_areas` and the
 * state part of a dealer code (GKS-KA-…). Nothing in the dealer programme is
 * tied to one state; a state's districts are added by an admin when it starts.
 */
export interface IndianState {
  code: string;
  name: string;
  kind: "STATE" | "UT";
}

export const INDIAN_STATES: readonly IndianState[] = [
  { code: "AP", name: "Andhra Pradesh", kind: "STATE" },
  { code: "AR", name: "Arunachal Pradesh", kind: "STATE" },
  { code: "AS", name: "Assam", kind: "STATE" },
  { code: "BR", name: "Bihar", kind: "STATE" },
  { code: "CG", name: "Chhattisgarh", kind: "STATE" },
  { code: "GA", name: "Goa", kind: "STATE" },
  { code: "GJ", name: "Gujarat", kind: "STATE" },
  { code: "HR", name: "Haryana", kind: "STATE" },
  { code: "HP", name: "Himachal Pradesh", kind: "STATE" },
  { code: "JH", name: "Jharkhand", kind: "STATE" },
  { code: "KA", name: "Karnataka", kind: "STATE" },
  { code: "KL", name: "Kerala", kind: "STATE" },
  { code: "MP", name: "Madhya Pradesh", kind: "STATE" },
  { code: "MH", name: "Maharashtra", kind: "STATE" },
  { code: "MN", name: "Manipur", kind: "STATE" },
  { code: "ML", name: "Meghalaya", kind: "STATE" },
  { code: "MZ", name: "Mizoram", kind: "STATE" },
  { code: "NL", name: "Nagaland", kind: "STATE" },
  { code: "OD", name: "Odisha", kind: "STATE" },
  { code: "PB", name: "Punjab", kind: "STATE" },
  { code: "RJ", name: "Rajasthan", kind: "STATE" },
  { code: "SK", name: "Sikkim", kind: "STATE" },
  { code: "TN", name: "Tamil Nadu", kind: "STATE" },
  { code: "TS", name: "Telangana", kind: "STATE" },
  { code: "TR", name: "Tripura", kind: "STATE" },
  { code: "UP", name: "Uttar Pradesh", kind: "STATE" },
  { code: "UK", name: "Uttarakhand", kind: "STATE" },
  { code: "WB", name: "West Bengal", kind: "STATE" },
  { code: "AN", name: "Andaman and Nicobar Islands", kind: "UT" },
  { code: "CH", name: "Chandigarh", kind: "UT" },
  { code: "DN", name: "Dadra and Nagar Haveli and Daman and Diu", kind: "UT" },
  { code: "DL", name: "Delhi", kind: "UT" },
  { code: "JK", name: "Jammu and Kashmir", kind: "UT" },
  { code: "LA", name: "Ladakh", kind: "UT" },
  { code: "LD", name: "Lakshadweep", kind: "UT" },
  { code: "PY", name: "Puducherry", kind: "UT" },
];

const BY_CODE = new Map(INDIAN_STATES.map((s) => [s.code, s]));

export function indianState(code: string | null | undefined): IndianState | null {
  return code ? (BY_CODE.get(code.toUpperCase()) ?? null) : null;
}

/** The state an area code belongs to: area codes start with the state's ("MH-PUN" → "MH"). */
export function stateCodeOfArea(areaCode: string | null | undefined): string | null {
  const head = areaCode?.split("-")[0] ?? "";
  return BY_CODE.has(head) ? head : null;
}

/** "Karnataka", "karnataka", "KA" → "KA"; null when it is not an Indian state or UT. */
export function stateCodeFromName(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toUpperCase().replace(/&/g, "AND").replace(/\s+/g, " ");
  if (!v) return null;
  if (BY_CODE.has(v)) return v;
  return INDIAN_STATES.find((s) => s.name.toUpperCase() === v)?.code ?? null;
}

const VOWELS = /[AEIOU]/g;

/**
 * A short code for a new district (2–4 capital letters, the district part of
 * a dealer code), not in `taken`: the first three letters, else first letter +
 * the next consonants, else first letters of the words, else a fourth letter.
 * Deterministic for the same name and `taken`.
 */
export function districtShortCode(name: string, taken: ReadonlySet<string>): string {
  const letters = name.toUpperCase().replace(/[^A-Z ]/g, "");
  const flat = letters.replace(/ /g, "");
  if (flat.length < 2) throw new Error("A district name needs at least two letters.");
  const words = letters.split(" ").filter(Boolean);
  const consonants = flat[0] + flat.slice(1).replace(VOWELS, "");
  const candidates = [
    flat.slice(0, 3),
    consonants.slice(0, 3),
    words.length > 1 ? words.map((w) => w[0]).join("").slice(0, 3) : "",
    flat.slice(0, 4),
    consonants.slice(0, 4),
  ];
  for (const c of candidates) if (c.length >= 2 && !taken.has(c)) return c;
  // Every natural candidate is taken: first two letters + a running letter pair.
  const base = flat.slice(0, 2);
  for (const a of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") for (const b of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (!taken.has(base + a + b)) return base + a + b;
  throw new Error("No short code left for this district.");
}
