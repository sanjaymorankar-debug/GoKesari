/**
 * Fuzzy matching of a bill line to the shop's products
 * (docs/inventory-accounting-2026-10): normalised words and character
 * trigrams, so "AMUL TAAZA TONED MILK 500ML POUCH" finds "Amul Taaza Toned
 * Milk 500 ml". Pure and cheap: a shop has hundreds of listings, not millions.
 */

const STOP = new Set(["the", "and", "of", "for", "with", "pkt", "pouch", "pack", "packet", "nos", "pcs", "pc", "x", "no", "rs", "mrp"]);

/** Lower-case words; numbers kept with their unit ("500ml" → "500ml"). */
export function normaliseText(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/(\d)\s+(ml|l|ltr|kg|g|gm|gms|gram|grams)\b/g, "$1$2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function tokens(raw: string | null | undefined): string[] {
  return normaliseText(raw)
    .split(" ")
    .filter((t) => t && !STOP.has(t));
}

function trigrams(text: string): Set<string> {
  const s = `  ${text} `;
  const out = new Set<string>();
  for (let i = 0; i < s.length - 2; i += 1) out.add(s.slice(i, i + 3));
  return out;
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 0–1: how alike two product descriptions are. */
export function similarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  const words = jaccard(ta, tb);
  const grams = jaccard(trigrams(normaliseText(a)), trigrams(normaliseText(b)));
  // Numbers (sizes) that disagree are a strong signal of a different pack size.
  const na = [...ta].filter((t) => /\d/.test(t));
  const nb = [...tb].filter((t) => /\d/.test(t));
  const sizeClash = na.length > 0 && nb.length > 0 && !na.some((x) => nb.includes(x));
  const score = 0.55 * grams + 0.45 * words;
  return Math.max(0, Math.min(1, sizeClash ? score * 0.6 : score));
}

/** Key the owner's corrections are remembered under. */
export function itemKey(description: string, supplierItemCode?: string | null): string {
  const code = (supplierItemCode ?? "").trim().toLowerCase();
  return code ? `code:${code}` : normaliseText(description).slice(0, 120);
}

export function supplierKey(gstin: string | null | undefined, name: string | null | undefined): string {
  const g = (gstin ?? "").replace(/\s+/g, "").toUpperCase();
  if (/^[0-9A-Z]{15}$/.test(g)) return g;
  return `name:${normaliseText(name).slice(0, 80)}`;
}

/** Invoice numbers compared the way suppliers print them: case, spaces, leading zeros and "/"-"-" ignored. */
export function invoiceNoKey(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s\-/\\._]+/g, "")
    .replace(/^0+(?=\d)/, "");
}
