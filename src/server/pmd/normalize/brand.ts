/**
 * Brand and manufacturer identity.
 *
 * "Samsung", "SAMSUNG", "Samsung India" and "Samsung India Electronics Pvt. Ltd."
 * must resolve to one brand while every original spelling is preserved (the alias
 * table stores them). The identity key is the normalised name with legal/geographic
 * suffixes removed and spaces closed up, so "Good Day" and "GoodDay" also agree.
 */
import type { NamedEntity } from "../types";
import { cleanDisplay, isNullLike, normalizeText } from "./text";

/** Trailing words that describe the legal entity or market, not the brand. Kept deliberately short. */
const TRAILING_NOISE = new Set([
  // legal form
  "pvt", "private", "ltd", "limited", "llp", "inc", "incorporated", "corp", "corporation", "co", "company",
  // company descriptors: sources often put the legal entity ("Britannia Industries") where the brand belongs
  "industries", "industry", "enterprises", "enterprise", "group", "holdings", "exports", "international",
  "products", "foods",
  // market / storefront words
  "india", "indian", "official", "store", "brand",
]);

/** Leading words that carry no identity. */
const LEADING_NOISE = new Set(["the"]);

function keyTokens(name: string): string[] {
  const tokens = normalizeText(name).split(" ").filter(Boolean);
  while (tokens.length > 1 && LEADING_NOISE.has(tokens[0])) tokens.shift();
  // Never strip down to nothing: "India" alone is a name, "Samsung India" is Samsung.
  while (tokens.length > 1 && TRAILING_NOISE.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens;
}

/** Identity key: tokens with spaces closed up. Empty string for unusable input. */
export function entityKey(name: string | null | undefined): string {
  if (!name || isNullLike(name)) return "";
  return keyTokens(name).join("");
}

/** Space-separated tokens of the key, used to strip the brand out of a product name. */
export function entityTokens(name: string | null | undefined): string[] {
  if (!name || isNullLike(name)) return [];
  return keyTokens(name);
}

export function normalizeEntity(raw: string | null | undefined): NamedEntity | null {
  if (raw == null || isNullLike(raw)) return null;
  const original = String(raw).trim();
  const key = entityKey(original);
  if (!key) return null;
  const display = cleanDisplay(original) ?? original;
  return { key, display, original };
}

/**
 * Sources such as Open Food Facts put several brands in one field
 * ("Amul, Gujarat Cooperative Milk Marketing Federation"). The first is the
 * product brand; the rest are kept as related names, never silently dropped.
 */
export function splitBrandList(raw: string | null | undefined): string[] {
  if (raw == null || isNullLike(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(raw).split(/[,;|]/)) {
    const cleaned = cleanDisplay(part);
    if (!cleaned || isNullLike(cleaned)) continue;
    const k = entityKey(cleaned);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(cleaned);
  }
  return out;
}

const COMPANY_HINT = /\b(ltd|limited|pvt|private|llp|inc|corp|corporation|company|federation|industries|foods|co-?operative|cooperative|enterprises|group)\b/i;

/** True when a name reads like a legal entity (a manufacturer) rather than a consumer brand. */
export function looksLikeCompany(name: string): boolean {
  return COMPANY_HINT.test(name);
}
