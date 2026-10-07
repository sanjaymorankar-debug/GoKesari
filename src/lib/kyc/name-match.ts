/**
 * Fuzzy name matching for seller verification (Part 3): compares the name on
 * a government record (PAN holder, GST legal/trade name, Udyam enterprise,
 * FSSAI licensee) with the names the seller gave us.
 *
 * Indian business names vary in predictable ways — "M/s", "Shri", initials
 * written out or not, "Pvt. Ltd." vs "Private Limited", word order on a PAN
 * ("PATIL RAHUL S" vs "Rahul S. Patil") — so the score is the better of a
 * token-set overlap (order-free) and Jaro-Winkler on the joined string
 * (typo-tolerant). Pure and deterministic; safe in client components.
 */

/** Words that say nothing about who the business is. */
const NOISE_WORDS = new Set([
  "M", "S", "MS", "MESSRS", "SHRI", "SHREE", "SRI", "SMT", "KUMARI", "KU", "MR", "MRS", "MISS", "DR",
  "THE", "AND", "OF", "PROP", "PROPRIETOR",
]);

/** Legal-form words, collapsed to one canonical token so "Pvt Ltd" equals "Private Limited". */
const LEGAL_FORMS: [RegExp, string][] = [
  [/\bPRIVATE\s+LIMITED\b|\bPVT\.?\s*LTD\.?\b|\bP\.?\s*LTD\.?\b/g, " PVTLTD "],
  [/\bLIMITED\b|\bLTD\.?\b/g, " LTD "],
  [/\bLIMITED\s+LIABILITY\s+PARTNERSHIP\b|\bL\.?L\.?P\.?\b/g, " LLP "],
  [/\bENTERPRISES?\b|\bENTPR?\b/g, " ENTERPRISE "],
  [/\bAND\s+COMPANY\b|&\s*CO\.?\b|\bAND\s+CO\.?\b/g, " CO "],
];

export function normalizeName(raw: string | null | undefined): string[] {
  let s = (raw ?? "").normalize("NFKC").toUpperCase();
  s = s.replace(/M\/S\.?/g, " ");
  for (const [pattern, canonical] of LEGAL_FORMS) s = s.replace(pattern, canonical);
  return s
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !NOISE_WORDS.has(t));
}

function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(b.length - 1, i + window);
    for (let j = lo; j <= hi; j += 1) {
      if (!bMatched[j] && a[i] === b[j]) {
        aMatched[i] = bMatched[j] = true;
        matches += 1;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Do two tokens refer to the same word? Exact, an initial, or a near-typo. */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  return a.length >= 4 && b.length >= 4 && jaroWinkler(a, b) >= 0.92;
}

/** Share of the shorter name's words found in the longer one, order ignored. */
function tokenSetScore(a: string[], b: string[]): number {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length === 0) return 0;
  const used = new Array<boolean>(long.length).fill(false);
  let hits = 0;
  for (const t of short) {
    const idx = long.findIndex((u, i) => !used[i] && tokensMatch(t, u));
    if (idx >= 0) {
      used[idx] = true;
      // An initial matching a full word counts for less than a whole word.
      hits += t.length === 1 || long[idx].length === 1 ? 0.6 : 1;
    }
  }
  // A one-word name inside a long one ("RAHUL" in "RAHUL DAIRY FARM PVTLTD") is weak evidence.
  const coverage = short.length / long.length;
  return (hits / short.length) * (0.6 + 0.4 * coverage);
}

/** 0–100: how likely two names refer to the same person or business. */
export function nameMatchScore(a: string | null | undefined, b: string | null | undefined): number {
  const ta = normalizeName(a);
  const tb = normalizeName(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const tokenScore = tokenSetScore(ta, tb);
  // Whole-string similarity only rescues spacing/typo differences ("SAIKRUPA"
  // vs "SAI KRUPA"); it is discounted so it can't outvote a different word.
  const jw = jaroWinkler(ta.join(""), tb.join(""));
  return Math.round(Math.max(tokenScore, jw * 0.8) * 100);
}

/** Best score of a record name against any of the names the seller gave, with which one matched. */
export function bestNameMatch(
  recordNames: (string | null | undefined)[],
  shopNames: (string | null | undefined)[],
): { score: number; recordName: string | null; shopName: string | null } {
  let best = { score: 0, recordName: null as string | null, shopName: null as string | null };
  for (const r of recordNames) {
    if (!r) continue;
    for (const s of shopNames) {
      if (!s) continue;
      const score = nameMatchScore(r, s);
      if (score > best.score) best = { score, recordName: r, shopName: s };
    }
  }
  return best;
}
