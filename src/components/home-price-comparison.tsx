/** F9 — the same product's price at nearby shops; the lowest tagged "Best price" with the saving against the highest. */
import Link from "next/link";

import { SafeImage } from "@/components/safe-image";
import { Card, Money } from "@/components/ui";
import { formatRupees } from "@/lib/board/format";
import { tr, type Lang } from "@/lib/board/i18n";
import { fill, HOME } from "@/lib/home-i18n";
import { formatQuantity } from "@/lib/money";
import type { ComparedProduct } from "@/server/services/price-comparison";

export function HomePriceComparison({ products, lang = "en" }: { products: ComparedProduct[]; lang?: Lang }) {
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
          {p.spreadPaise > 0 ? (
            <p className="mb-2 rounded-md bg-leaf-50 px-2 py-1 text-xs font-bold text-leaf-700" data-testid="compare-saving">
              {fill(tr(HOME.saveVsHighest, lang), { amount: formatRupees(p.spreadPaise) ?? "" })}
            </p>
          ) : null}
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
                  {price.cheapest ? (
                    <span className="rounded-full bg-leaf-700 px-2 py-0.5 text-[0.6875rem] font-extrabold uppercase tracking-wide text-white" data-testid="best-price">
                      {tr(HOME.bestPrice, lang)}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-auto pt-3">
            <Link
              href={`/products/${p.productId}`}
              aria-label={`Compare all shops: ${p.productName}`}
              data-accent="smart"
              className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-indigo-700 px-3 text-xs font-bold text-white hover:bg-indigo-800"
            >
              Compare all shops
              <span className="rounded-full bg-white px-1.5 py-0.5 text-[0.625rem] font-extrabold uppercase text-indigo-800">{tr(HOME.smartTool, lang)}</span>
            </Link>
          </div>
        </Card>
      ))}
    </div>
  );
}
