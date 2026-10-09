"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { formatRupees } from "@/lib/board/format";

import { Icon } from "./icons";
import { priceUnitLabel } from "@/lib/board/product-look";

export interface BuyAgainRow {
  shopProductId: string;
  name: string;
  unit: string;
  shopName: string;
  imageUrl: string | null;
  pricePaise: number;
}

/**
 * "Buy again" on the wide customer board: items from delivered orders that
 * can be bought right now, each added through the existing cart API (which
 * re-checks purchasability and price on the server).
 */
export function BuyAgainList({
  items,
  labels,
}: {
  items: BuyAgainRow[];
  labels: { add: string; added: string; empty: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  async function add(id: string) {
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
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add to cart.");
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) return <p className="px-1 py-6 text-sm text-ink-600">{labels.empty}</p>;
  return (
    <>
      {error ? (
        <p role="alert" className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      <ul className="divide-y divide-cream-200">
        {items.map((item) => (
          <li key={item.shopProductId} className="flex items-center gap-3 py-2.5">
            <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-kesari-50 text-kesari-700">
              {item.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.imageUrl} alt="" width={48} height={48} className="h-full w-full object-cover" loading="lazy" />
              ) : (
                <Icon name="package" size={22} />
              )}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-bold text-ink-900">
                {item.name}
              </span>
              <span className="block truncate text-xs text-ink-600">{item.shopName}</span>
            </span>
            <span className="shrink-0 text-sm font-bold tabular-nums text-ink-900">
              {formatRupees(item.pricePaise)}
              <span className="font-medium text-ink-600"> {priceUnitLabel(item.unit)}</span>
            </span>
            <button
              type="button"
              onClick={() => add(item.shopProductId)}
              disabled={busy !== null}
              data-testid="buy-again-add"
              className="h-9 shrink-0 rounded-xl border-2 border-kesari-700 px-3 text-sm font-bold text-kesari-800 hover:bg-kesari-50 disabled:opacity-60"
            >
              {added.has(item.shopProductId) ? labels.added : labels.add}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
