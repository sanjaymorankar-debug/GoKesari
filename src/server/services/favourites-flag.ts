/**
 * docs/search-brand-barcode-favourites-2026-11: is the flag brand_barcode_favourites_enabled on? For
 * pages that pass `favourites` to ProductGrid. A failed read counts as off (the page as before).
 */
import { isFeatureEnabled } from "./feature-flags";

export function favouritesOn(): Promise<boolean> {
  return isFeatureEnabled("brand_barcode_favourites_enabled").catch(() => false);
}
