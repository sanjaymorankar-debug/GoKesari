/**
 * Which of the shop's products each bill line is (docs/inventory-accounting-2026-10, Part 4),
 * and what the billed quantity is in that product's sellable units.
 *
 * In order: what the owner chose last time for this supplier's line text
 * (the remembered mapping — corrections feed back here), the barcode / GTIN,
 * HSN + name similarity, then name similarity alone. A line with no
 * confident match gets suggestions and the "create new product" option.
 */
import { and, eq } from "drizzle-orm";

import type { BillDraft, DraftLine } from "@/lib/accounts/bill-draft";
import { itemKey, similarity, supplierKey } from "@/lib/accounts/text-match";
import { normaliseUnit, toStockQtyMilli } from "@/lib/accounts/units";
import { db } from "@/server/db";
import { invSupplierItemMaps, invUnitConversions } from "@/server/db/schema";
import { listListings, type ListingInfo } from "../stock";

const NAME_THRESHOLD = 0.5;
const HSN_NAME_THRESHOLD = 0.3;

export async function matchDraft(shopId: string, draft: BillDraft): Promise<BillDraft> {
  const [listings, maps, conversions] = await Promise.all([
    listListings(shopId),
    db.select().from(invSupplierItemMaps).where(and(eq(invSupplierItemMaps.shopId, shopId), eq(invSupplierItemMaps.supplierKey, supplierKey(draft.supplierGstin.value, draft.supplierName.value)))),
    db.select().from(invUnitConversions).where(eq(invUnitConversions.shopId, shopId)),
  ]);
  const byId = new Map(listings.map((l) => [l.shopProductId, l]));
  const lines = draft.lines.map((line) => matchLine(line, listings, byId, maps, conversions));
  return { ...draft, lines };
}

/** Re-runs only the unit conversion of a line (after the owner changed product or unit). */
export async function refreshConversions(shopId: string, draft: BillDraft): Promise<BillDraft> {
  const ids = draft.lines.map((l) => l.match.shopProductId).filter(Boolean) as string[];
  const [listings, conversions] = await Promise.all([listListings(shopId, ids), db.select().from(invUnitConversions).where(eq(invUnitConversions.shopId, shopId))]);
  const byId = new Map(listings.map((l) => [l.shopProductId, l]));
  return {
    ...draft,
    lines: draft.lines.map((line) => {
      const listing = line.match.shopProductId ? byId.get(line.match.shopProductId) : undefined;
      if (line.match.shopProductId && !listing) {
        return { ...line, match: { ...line.match, shopProductId: null, productName: null, method: null, conversionProblem: null } };
      }
      return listing ? withConversion(line, listing, conversions) : line;
    }),
  };
}

function withConversion(line: DraftLine, listing: ListingInfo, conversions: (typeof invUnitConversions.$inferSelect)[]): DraftLine {
  const unit = normaliseUnit(line.unit.value);
  const saved =
    line.match.milliPerUnit ??
    (unit ? (conversions.find((c) => c.shopProductId === listing.shopProductId && c.unit === unit) ?? conversions.find((c) => c.shopProductId === null && c.unit === unit))?.milliPerUnit ?? null : null);
  const qty = line.qtyMilli.value;
  if (!qty) return { ...line, match: { ...line.match, productName: listing.name, sellableUnit: listing.sellableUnit, stockQtyMilli: null, conversionProblem: null } };
  const conv = toStockQtyMilli(qty, line.unit.value, { unit: listing.unit, unitSizeMilli: listing.unitSizeMilli }, saved);
  return {
    ...line,
    match: {
      ...line.match,
      productName: listing.name,
      sellableUnit: listing.sellableUnit,
      milliPerUnit: saved,
      stockQtyMilli: conv.ok ? conv.stockQtyMilli : null,
      conversionProblem: conv.ok ? null : conv.message,
    },
  };
}

function matchLine(
  line: DraftLine,
  listings: ListingInfo[],
  byId: Map<string, ListingInfo>,
  maps: (typeof invSupplierItemMaps.$inferSelect)[],
  conversions: (typeof invUnitConversions.$inferSelect)[],
): DraftLine {
  // Kept as chosen (the owner already mapped it, or asked for a new product).
  if (line.match.method === "USER" || line.match.method === "NEW") {
    const listing = line.match.shopProductId ? byId.get(line.match.shopProductId) : undefined;
    return listing ? withConversion(line, listing, conversions) : line;
  }
  const desc = line.description.value;
  const scored = listings
    .map((l) => ({ l, score: similarity(desc, l.name) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const suggestions = scored.filter((s) => s.score > 0.15).slice(0, 3).map((s) => ({ shopProductId: s.l.shopProductId, name: s.l.name, score: Math.round(s.score * 100) / 100 }));

  const pick = (l: ListingInfo, method: DraftLine["match"]["method"], score: number, milliPerUnit: number | null = null): DraftLine =>
    withConversion({ ...line, match: { ...line.match, shopProductId: l.shopProductId, productName: l.name, method, score, suggestions, milliPerUnit: milliPerUnit ?? line.match.milliPerUnit ?? null } }, l, conversions);

  const remembered = maps.find((m) => m.itemKey === itemKey(desc, line.supplierItemCode));
  if (remembered && byId.has(remembered.shopProductId)) {
    const sameUnit = !remembered.unit || remembered.unit === normaliseUnit(line.unit.value);
    return pick(byId.get(remembered.shopProductId)!, "SUPPLIER_MAP", 1, sameUnit ? remembered.milliPerUnit : null);
  }
  const code = line.barcode.value?.replace(/\D/g, "");
  if (code && code.length >= 8) {
    const hit = listings.find((l) => l.gtin === code || l.barcode === code);
    if (hit) return pick(hit, "BARCODE", 1);
  }
  const hsn = line.hsn.value?.replace(/\D/g, "");
  if (hsn && hsn.length >= 4) {
    const sameHsn = scored.find((s) => s.l.hsn && (s.l.hsn.startsWith(hsn.slice(0, 4)) || hsn.startsWith(s.l.hsn.slice(0, 4))) && s.score >= HSN_NAME_THRESHOLD);
    if (sameHsn) return pick(sameHsn.l, "HSN_NAME", Math.round(sameHsn.score * 100) / 100);
  }
  if (scored[0] && scored[0].score >= NAME_THRESHOLD) return pick(scored[0].l, "NAME", Math.round(scored[0].score * 100) / 100);
  return { ...line, match: { ...line.match, shopProductId: null, productName: null, method: null, score: 0, suggestions } };
}
