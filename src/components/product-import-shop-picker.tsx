"use client";

/** docs/product-import-2026-10: an operator or admin picks the shop to upload products for. */
import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge, Card, inputClass } from "@/components/ui";

interface ShopOption {
  id: string;
  name: string;
  city: string;
  status: string;
}

export function ProductImportShopPicker({ initial }: { initial: ShopOption[] }) {
  const [query, setQuery] = useState("");
  const [shops, setShops] = useState<ShopOption[]>(initial);

  useEffect(() => {
    const t = setTimeout(async () => {
      const res = await fetch(`/api/v1/product-imports/shops?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      if (res.ok) setShops(((await res.json()) as { shops: ShopOption[] }).shops);
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <Card className="space-y-3 p-4" data-testid="product-import-shop-picker">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">Shop</span>
        <input
          className={inputClass}
          placeholder="Search by shop name or city"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search shops"
        />
      </label>
      {shops.length === 0 ? (
        <p className="text-sm text-ink-500">No shop matches.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {shops.map((s) => (
            <li key={s.id}>
              <Link
                href={`/admin/product-import?shopId=${s.id}`}
                className="flex min-h-14 items-center justify-between gap-2 rounded-xl border border-cream-200 bg-white p-3 text-sm shadow-sm hover:bg-cream-50"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink-900">{s.name}</span>
                  <span className="block text-xs text-ink-500">{s.city}</span>
                </span>
                <Badge tone={s.status === "APPROVED" ? "success" : "neutral"}>{s.status.replace(/_/g, " ").toLowerCase()}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
