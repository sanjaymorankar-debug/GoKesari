"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Alert, Button, inputClass } from "@/components/ui";

/**
 * Step 8 of the registration — the starter shelf (onboarding Phase B, services/starter-shelf.ts):
 * the products other shops in the chosen categories stock most, already ticked, priced at their
 * MRP and with the default stock (owner, 05-Nov-2026: 100 products × stock 100). The owner
 * unticks what they don't sell, changes a price or a quantity, and publishes them in one go.
 */

interface Item {
  productId: string;
  name: string;
  categoryName: string;
  imageUrl: string | null;
  unit: string;
  kind: "PACKAGED" | "LOOSE";
  mrpPaise: number | null;
}

interface Row {
  ticked: boolean;
  price: string;
  stock: string;
}

const rupees = (paise: number) => (paise / 100).toFixed(paise % 100 === 0 ? 0 : 2);

export function StarterShelf({ shopId, onDone }: { shopId: string; onDone: () => Promise<void> }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ productId: string; reason: string }[]>([]);
  const [discount, setDiscount] = useState("0");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch(`/api/shops/${shopId}/starter-shelf`).catch(() => null);
      const payload = await response?.json().catch(() => null);
      if (cancelled) return;
      if (!response?.ok || !payload) {
        setLoadError(payload?.error?.message ?? "Could not load the suggested products.");
        return;
      }
      const list: Item[] = payload.enabled ? payload.items : [];
      setItems(list);
      setRows(
        Object.fromEntries(
          list.map((i) => [
            i.productId,
            // A product with no MRP (loose goods) needs the owner's own price, so it starts unticked.
            { ticked: i.mrpPaise != null, price: i.mrpPaise != null ? rupees(i.mrpPaise) : "", stock: String(payload.defaultStock) },
          ]),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [shopId]);

  const ticked = useMemo(() => (items ?? []).filter((i) => rows[i.productId]?.ticked), [items, rows]);
  const set = (id: string, patch: Partial<Row>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));

  /** "x % below MRP" for every ticked product that has an MRP. */
  function applyDiscount() {
    const pct = Math.min(90, Math.max(0, Number(discount) || 0));
    setRows((r) => {
      const next = { ...r };
      for (const i of items ?? []) {
        if (i.mrpPaise != null && next[i.productId]?.ticked) next[i.productId] = { ...next[i.productId], price: rupees(Math.round((i.mrpPaise * (100 - pct)) / 100)) };
      }
      return next;
    });
  }

  async function publish() {
    setError(null);
    const picks = [];
    for (const i of ticked) {
      const row = rows[i.productId];
      const price = Math.round(Number(row.price) * 100);
      const stock = Number(row.stock);
      if (!Number.isFinite(price) || price < 1) return setError(`Enter a price for ${i.name}, or untick it.`);
      if (i.mrpPaise != null && price > i.mrpPaise) return setError(`${i.name}: the price cannot be above the MRP (₹${rupees(i.mrpPaise)}).`);
      if (!Number.isFinite(stock) || stock < 0) return setError(`Enter the quantity you have of ${i.name}.`);
      picks.push({ productId: i.productId, pricePaise: price, stock });
    }
    if (picks.length === 0) return setError("Tick at least one product.");
    setBusy(true);
    const response = await fetch(`/api/shops/${shopId}/starter-shelf`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: picks }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    setBusy(false);
    if (!response?.ok) return setError(payload?.error?.message ?? "Could not publish the products. Please try again.");
    setFailed(payload.failed ?? []);
    if ((payload.added ?? 0) > 0) await onDone();
  }

  if (loadError) return <Alert tone="danger">{loadError}</Alert>;
  if (!items) return <p className="text-sm text-ink-600">Finding products for your shop…</p>;
  if (items.length === 0) return null;

  return (
    <div className="space-y-3" data-testid="starter-shelf">
      <p className="text-sm text-ink-700">
        <strong>{ticked.length}</strong> of {items.length} products ticked. Untick what you don&apos;t sell, and change the price or quantity where yours differs.
      </p>
      <div className="flex flex-wrap items-end gap-2 rounded-xl bg-cream-50 p-2">
        <label className="text-sm text-ink-700">
          Price for all: % below MRP
          <input className={`${inputClass} mt-1 w-24`} inputMode="numeric" value={discount} onChange={(e) => setDiscount(e.target.value)} aria-label="Percent below MRP" />
        </label>
        <Button type="button" variant="secondary" onClick={applyDiscount}>
          Apply
        </Button>
      </div>
      <ul className="max-h-[28rem] divide-y divide-cream-100 overflow-y-auto rounded-xl border border-[var(--gk-line)] bg-white">
        {items.map((i) => {
          const row = rows[i.productId];
          const why = failed.find((f) => f.productId === i.productId)?.reason;
          return (
            <li key={i.productId} className="grid grid-cols-2 items-end gap-2 p-2 sm:grid-cols-[1fr_7rem_6rem]" data-testid={`shelf-${i.productId}`}>
              <label className="col-span-2 flex min-h-11 min-w-0 items-center gap-2 text-sm sm:col-span-1">
                <input type="checkbox" className="h-5 w-5 shrink-0" checked={row?.ticked ?? false} onChange={(e) => set(i.productId, { ticked: e.target.checked })} />
                {i.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- product-master images come from several hosts
                  <img src={i.imageUrl} alt="" className="h-10 w-10 shrink-0 rounded object-cover" loading="lazy" />
                ) : null}
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink-900">{i.name}</span>
                  <span className="block text-xs text-ink-500">
                    {i.categoryName}
                    {i.mrpPaise != null ? ` · MRP ₹${rupees(i.mrpPaise)}` : " · loose — set your price"}
                  </span>
                </span>
              </label>
              <label className="text-xs text-ink-600">
                Price ₹
                <input
                  className={`${inputClass} mt-0.5 w-full`}
                  inputMode="decimal"
                  value={row?.price ?? ""}
                  onChange={(e) => set(i.productId, { price: e.target.value, ticked: true })}
                  aria-label={`Price of ${i.name}`}
                />
              </label>
              <label className="text-xs text-ink-600">
                Qty ({i.unit})
                <input
                  className={`${inputClass} mt-0.5 w-full`}
                  inputMode="decimal"
                  value={row?.stock ?? ""}
                  onChange={(e) => set(i.productId, { stock: e.target.value })}
                  aria-label={`Quantity of ${i.name}`}
                />
              </label>
              {why ? <p className="col-span-2 text-xs text-red-700 sm:col-span-3">{why}</p> : null}
            </li>
          );
        })}
      </ul>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="button" size="lg" className="w-full" disabled={busy || ticked.length === 0} onClick={() => void publish()} data-testid="starter-shelf-publish">
        {busy ? "Publishing…" : `Publish ${ticked.length} products`}
      </Button>
      <p className="text-center text-sm text-ink-600">
        Or{" "}
        <Link href="/shop/product-import" className="font-medium text-kesari-700 underline">
          upload your own list from Excel
        </Link>
      </p>
    </div>
  );
}
