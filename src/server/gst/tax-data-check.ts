/**
 * Missing tax data at checkout (rule invoicing.missingTaxData).
 *
 * A GST-registered shop's invoice needs an HSN code and a GST rate on every
 * line. The rate is found the same way the invoice finds it (listing, master
 * product, dated HSN table); a line where neither the HSN nor a rate can be
 * found is "missing". ALLOW (default) keeps today's behaviour — the line is
 * invoiced at invoicing.defaultGstRateBp and marked, and the product shows in
 * the admin queue at /admin/product-gst ("missing" filter). BLOCK refuses the
 * checkout for that shop's lines until the shop or an admin fills them in.
 */
import { eq, inArray } from "drizzle-orm";

import { db, type DbClient } from "@/server/db";
import { products, shopProducts, type Shop } from "@/server/db/schema";
import { hsnFallbackRate } from "./rules";

/** Whether a shop issues tax invoices (GSTIN on record, not composition). Bills of supply need no rate. */
export function chargesGst(shop: Pick<Shop, "gstin" | "gstStatus">): boolean {
  return Boolean(shop.gstin && /^\d{2}[A-Z0-9]{13}$/.test(shop.gstin) && shop.gstStatus !== "COMPOSITION");
}

/** The listings among `shopProductIds` with no HSN code or no GST rate that an invoice could use. */
export async function listingsMissingTaxData(shopProductIds: string[], at: Date = new Date(), client: DbClient = db): Promise<Set<string>> {
  const missing = new Set<string>();
  if (shopProductIds.length === 0) return missing;
  const rows = await client
    .select({
      id: shopProducts.id,
      shopHsn: shopProducts.hsnCode,
      shopRate: shopProducts.gstRateBp,
      hsn: products.hsnCode,
      rate: products.gstRateBp,
    })
    .from(shopProducts)
    .leftJoin(products, eq(products.id, shopProducts.productId))
    .where(inArray(shopProducts.id, shopProductIds));
  for (const r of rows) {
    const hsn = r.shopHsn ?? r.hsn;
    if (!hsn) {
      missing.add(r.id);
      continue;
    }
    if ((r.shopRate ?? r.rate) == null && !(await hsnFallbackRate(hsn, at, client))) missing.add(r.id);
  }
  return missing;
}
