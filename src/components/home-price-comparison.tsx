/** F9 — the same product's price at nearby shops, cheapest highlighted. */
import Link from "next/link";

import { SafeImage } from "@/components/safe-image";
import { Badge, Card, Money } from "@/components/ui";
import { formatQuantity } from "@/lib/money";
import type { ComparedProduct } from "@/server/services/price-comparison";

export function HomePriceComparison({ products }: { products: ComparedProduct[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="home-price-comparison">
      {products.map((p) => (
        <Card key={p.productId} className="flex flex-col p-4">
          <div className="mb-3 flex items-center gap-3">
            <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-cream-100">
              <SafeImage src={p.imageUrl} alt={p.productName} className="h-full w-full object-cover" />
            </div>
            <div className="min-w-0">
              <Link href={`/products/${p.productId}`} className="font-medium text-ink-900 hover:underline">
                {p.productName}
              </Link>
              <p className="text-xs text-ink-500">{formatQuantity(p.unitSizeMilli, p.unit)}</p>
            </div>
          </div>
          <ul className="space-y-1 text-sm">
            {p.prices.map((price) => (
              <li
                key={price.shopProductId}
                className={`flex items-center justify-between gap-2 rounded-md px-2 py-1 ${price.cheapest ? "bg-leaf-50 font-semibold text-leaf-800" : "text-ink-700"}`}
                data-testid={price.cheapest ? "cheapest-price" : "compared-price"}
              >
                <Link href={`/shops/${price.shopSlug}`} className="min-w-0 truncate hover:underline">
                  {price.shopName}
                  {price.distanceKm != null ? <span className="text-xs font-normal text-ink-500"> · {price.distanceKm} km</span> : null}
                </Link>
                <span className="flex shrink-0 items-center gap-1">
                  {price.listPricePaise ? (
                    <span className="text-xs font-normal text-ink-500 line-through">
                      <Money paise={price.listPricePaise} />
                    </span>
                  ) : null}
                  <Money paise={price.pricePaise} />
                  {price.cheapest ? <Badge tone="success">Cheapest</Badge> : null}
                </span>
              </li>
            ))}
          </ul>
          <Link href={`/products/${p.productId}`} className="mt-auto pt-3 text-xs font-medium text-kesari-700 hover:underline">
            Compare all shops →
          </Link>
        </Card>
      ))}
    </div>
  );
}
