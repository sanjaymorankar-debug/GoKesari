/**
 * Group C (20-Nov-2026), production-safe: what a guest's app reads of approved shops'
 * catalogues — only Live listings (src/lib/listing-status.ts, catalogue.ts storefrontLive).
 * GETs only.
 */
import { anonymous, call, pace } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";

qa("TC-CAT-073", "the public catalogue of approved shops offers only Live listings: every product GET /api/shops/<id>/products returns is priced and in stock", async () => {
  const guest = await anonymous();
  const shops = await call(guest, "GET", "/api/shops?limit=24");
  expect(shops.status, "GET /api/shops").toBe(200);
  const list = (Array.isArray(shops.body) ? shops.body : (shops.body?.shops ?? [])) as { id: string; name: string }[];
  if (!list.length) blocked("no approved shop is listed on this site");
  const seen: string[] = [];
  for (const shop of list.slice(0, 5)) {
    await pace(300);
    const res = await call(guest, "GET", `/api/shops/${shop.id}/products?limit=100`);
    expect(res.status, `${shop.name}'s products`).toBe(200);
    const rows = res.body as { productName: string; onlinePricePaise: number | null; inStock: boolean }[];
    for (const r of rows) {
      expect(r.onlinePricePaise, `${shop.name}: ${r.productName} offered without a price`).not.toBeNull();
      expect(r.inStock, `${shop.name}: ${r.productName} offered while out of stock`).toBe(true);
    }
    seen.push(`${shop.name} ${rows.length}`);
  }
  return `every listing offered is priced and in stock (${seen.join(", ")})`;
}, { partial: "checks the rule on the site's own data as a guest; Needs Stock, Needs Price, Out of Stock and Paused listings are arranged and checked in tests/qa/signed-in/sellers-product-setup.spec.ts" });
