"use client";

/**
 * Product tiles for the home page's "Buy again" and "Popular in your area"
 * (docs/homepage-uiux-2026-10, F3/F4): picture, name, shop, price and an Add
 * button that goes through the existing cart API (which re-checks the
 * listing and price on the server). A product sold by two or more shops
 * near the visitor also offers "Compare N prices".
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import clsx from "clsx";

import { Icon } from "@/components/board/icons";
import { formatRupees } from "@/lib/board/format";
import { tr, UI, type Lang } from "@/lib/board/i18n";
import { priceUnitLabel } from "@/lib/board/product-look";
import { fill, HOME } from "@/lib/home-i18n";

export interface ProductTile {
  shopProductId: string;
  productId: string;
  name: string;
  unit: string;
  shopName: string;
  shopSlug: string;
  imageUrl: string | null;
  pricePaise: number;
  /** Nearby shops selling it online; "Compare N prices" from 2. */
  compareCount: number;
}

export function ProductTiles({ lang, items, signedIn, testId }: { lang: Lang; items: ProductTile[]; signedIn: boolean; testId: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  async function add(id: string) {
    if (!signedIn) {
      router.push("/signin");
      return;
    }
    setBusy(id);
    setError(null);
    try {
      const response = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopProductId: id, quantity: 1 }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "Could not add to cart.");
      setAdded((prev) => new Set(prev).add(id));
      startTransition(() => router.refresh());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add to cart.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error ? (
        <p role="alert" className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4" data-testid={testId}>
        {items.map((item) => {
          const isAdded = added.has(item.shopProductId);
          return (
            <li key={item.shopProductId} className="flex min-w-0 flex-col rounded-2xl border border-[var(--gk-line)] bg-white p-2.5" data-testid="product-tile">
              <Link href={`/products/${item.productId}?shop=${encodeURIComponent(item.shopSlug)}`} className="block min-w-0">
                <span className="mb-2 grid aspect-square w-full place-items-center overflow-hidden rounded-xl bg-kesari-50 text-kesari-700">
                  {item.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.imageUrl} alt="" width={160} height={160} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                  ) : (
                    <Icon name="package" size={36} />
                  )}
                </span>
                <span className="line-clamp-2 min-h-[2.5rem] text-sm font-bold leading-tight text-ink-900">{item.name}</span>
                <span className="mt-0.5 block truncate text-xs text-ink-600">{item.shopName}</span>
              </Link>
              <span className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-sm font-bold tabular-nums text-ink-900">
                  {formatRupees(item.pricePaise)}
                  <span className="text-xs font-medium text-ink-600"> {priceUnitLabel(item.unit)}</span>
                </span>
                <button
                  type="button"
                  onClick={() => add(item.shopProductId)}
                  disabled={busy !== null}
                  data-testid="product-tile-add"
                  className={clsx(
                    "h-10 min-w-16 shrink-0 rounded-xl border-2 px-3 text-sm font-bold disabled:opacity-60",
                    isAdded ? "border-leaf-600 bg-leaf-50 text-leaf-700" : "border-kesari-700 bg-white text-kesari-800 hover:bg-kesari-50",
                  )}
                >
                  {isAdded ? tr(UI.added, lang) : tr(UI.add, lang)}
                </button>
              </span>
              {item.compareCount >= 2 ? (
                <Link
                  href={`/search/compare?product=${encodeURIComponent(item.productId)}`}
                  data-testid="compare-n-prices"
                  className="mt-2 inline-flex min-h-9 items-center gap-1 self-start rounded-full bg-indigo-50 px-2.5 text-xs font-bold text-indigo-800 hover:bg-indigo-100"
                >
                  <Icon name="scale" size={14} />
                  {fill(tr(HOME.comparePricesN, lang), { n: item.compareCount })}
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
