/**
 * Which description customers see (Module 1, docs/three-modules-2026-10): a
 * shop's own short/long description of a product, else the master product's.
 * Dependency-free so the storefront query, the shop editor and client
 * components can all use it.
 */

/** The first `max` characters of a text, cut at a word boundary, with an ellipsis when cut. */
export function summarise(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface EffectiveDescriptions {
  shortDescription: string | null;
  longDescription: string | null;
  /** Where each came from: the shop's own text or the master product's. */
  shortSource: "SHOP" | "MASTER" | null;
  longSource: "SHOP" | "MASTER" | null;
}

/**
 * What customers see: the shop's own short/long description, else the master
 * product's description (summarised for the short one).
 */
export function effectiveDescriptions(
  listing: { shortDescription: string | null; longDescription: string | null },
  masterDescription: string | null,
  shortMax = 160,
): EffectiveDescriptions {
  const master = masterDescription?.trim() || null;
  const short = listing.shortDescription ?? (master ? summarise(master, shortMax) : null);
  const long = listing.longDescription ?? master;
  return {
    shortDescription: short,
    longDescription: long,
    shortSource: listing.shortDescription ? "SHOP" : short ? "MASTER" : null,
    longSource: listing.longDescription ? "SHOP" : long ? "MASTER" : null,
  };
}
