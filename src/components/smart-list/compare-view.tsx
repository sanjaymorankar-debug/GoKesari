"use client";

/**
 * Wishlist price comparison (docs/smart-shopping-2026-11, Feature 1 §4–5): shop cards (distance, rating,
 * X of Y items, missing items, total, delivery options with fee and ETA), sorted by lowest total / nearest /
 * most items; a shop opens its per-item breakdown; a grid shows each item's price in each shop. "Which shop
 * do you want to order from?" — the chosen shop's available items go into the normal cart.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { tr, type Lang } from "@/lib/board/i18n";
import { FULFILMENT_OPTION_LABELS } from "@/lib/fulfilment-options";
import type { CompareSort } from "@/lib/smart-list";
import type { Comparison, ShopQuote } from "@/server/services/smart-list/compare";

const T = {
  ask: { en: "Which shop do you want to order from?", hi: "आप किस दुकान से ऑर्डर करना चाहते हैं?", mr: "तुम्हाला कोणत्या दुकानातून ऑर्डर करायची आहे?" },
  sortTotal: { en: "Lowest total", hi: "सबसे कम कुल", mr: "सर्वात कमी एकूण" },
  sortNear: { en: "Nearest", hi: "सबसे पास", mr: "सर्वात जवळ" },
  sortMost: { en: "Most items", hi: "सबसे ज़्यादा आइटम", mr: "सर्वाधिक वस्तू" },
  items: { en: "items available", hi: "आइटम उपलब्ध", mr: "वस्तू उपलब्ध" },
  missing: { en: "Missing", hi: "नहीं है", mr: "नाही" },
  total: { en: "Total", hi: "कुल", mr: "एकूण" },
  poc: { en: "Price on confirmation", hi: "पुष्टि पर दाम", mr: "पुष्टीनंतर किंमत" },
  pocNote: { en: "not in the total", hi: "कुल में नहीं", mr: "एकूणमध्ये नाही" },
  order: { en: "Order from this shop", hi: "इस दुकान से ऑर्डर करें", mr: "या दुकानातून ऑर्डर करा" },
  details: { en: "Item prices", hi: "आइटम के दाम", mr: "वस्तूंच्या किमती" },
  grid: { en: "Compare item by item", hi: "आइटम-दर-आइटम तुलना", mr: "वस्तूनिहाय तुलना" },
  similar: { en: "similar", hi: "मिलता-जुलता", mr: "सारखे" },
  none: {
    en: "No shop within the radius has items from your list right now.",
    hi: "दायरे में किसी दुकान पर अभी आपकी सूची का सामान नहीं है।",
    mr: "या अंतरात कोणत्याही दुकानात सध्या तुमच्या यादीतील वस्तू नाहीत.",
  },
  eta: { en: "min (est.)", hi: "मिनट (अनुमान)", mr: "मिनिटे (अंदाज)" },
  free: { en: "free", hi: "मुफ़्त", mr: "मोफत" },
  changed: { en: "Changed since you compared", hi: "तुलना के बाद बदला", mr: "तुलनेनंतर बदलले" },
  goCart: { en: "Go to cart & pay", hi: "कार्ट पर जाएँ और भुगतान करें", mr: "कार्टवर जा आणि पैसे भरा" },
  notAdded: { en: "Not ordered (stays in your wishlist)", hi: "ऑर्डर नहीं हुआ (विशलिस्ट में रहेगा)", mr: "ऑर्डर नाही (विशलिस्टमध्ये राहील)" },
  km: { en: "km", hi: "किमी", mr: "किमी" },
};

const rupees = (p: number | null) => (p == null ? "—" : `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);

export function CompareView({ lang, wishlistId, comparison, itemNames }: { lang: Lang; wishlistId: string; comparison: Comparison; itemNames: Record<string, string> }) {
  const router = useRouter();
  const [sort, setSort] = useState<CompareSort>("TOTAL");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{
    shopName: string;
    added: { itemId: string; productName: string; quantity: number }[];
    notAdded: { itemId: string; name: string; reason: string }[];
    changes: { itemId: string; name: string; before: number | null; now: number | null; note: string }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shops = useMemo(() => {
    const list = [...comparison.shops];
    list.sort((a, b) =>
      sort === "NEAREST"
        ? (a.distanceKm ?? 99) - (b.distanceKm ?? 99)
        : sort === "MOST_ITEMS"
          ? b.available - a.available || a.cheapestTotalPaise - b.cheapestTotalPaise
          : a.cheapestTotalPaise - b.cheapestTotalPaise || b.available - a.available,
    );
    return list;
  }, [comparison.shops, sort]);

  async function orderFrom(shop: ShopQuote) {
    setBusy(shop.shopId);
    setError(null);
    const seen: Record<string, number | null> = {};
    for (const q of shop.items) seen[q.itemId] = q.status === "AVAILABLE" || q.status === "SIMILAR" ? q.linePaise : null;
    const res = await fetch(`/api/smart-list/wishlists/${wishlistId}/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shopId: shop.shopId, seen }),
    });
    setBusy(null);
    const body = await res.json().catch(() => null);
    if (!res.ok) return setError(body?.error?.message ?? "Could not add to cart. Try again.");
    setResult({ shopName: shop.shopName, ...body });
    router.refresh();
  }

  if (result) {
    return (
      <div className="space-y-3 rounded-2xl border-2 border-leaf-400 bg-white p-4" data-testid="order-result">
        <h2 className="text-lg font-extrabold">{result.shopName}</h2>
        {result.changes.length > 0 ? (
          <div className="rounded-xl bg-amber-50 p-3 text-sm" data-testid="order-changes">
            <strong>{tr(T.changed, lang)}:</strong>
            <ul className="list-disc pl-5">
              {result.changes.map((c) => (
                <li key={c.itemId}>
                  {c.name}: {c.note} ({rupees(c.before)} → {rupees(c.now)})
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <ul className="text-sm">
          {result.added.map((a) => (
            <li key={a.itemId}>
              ✓ {a.productName} × {a.quantity}
            </li>
          ))}
        </ul>
        {result.notAdded.length > 0 ? (
          <div className="text-sm">
            <strong>{tr(T.notAdded, lang)}:</strong>
            <ul className="list-disc pl-5">
              {result.notAdded.map((n) => (
                <li key={n.itemId}>
                  {n.name} — {n.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Link href="/cart" className="inline-flex h-12 items-center rounded-xl bg-kesari-600 px-5 font-bold text-white">
            {tr(T.goCart, lang)}
          </Link>
          <Link href={`/wishlist/${wishlistId}`} className="inline-flex h-12 items-center rounded-xl border-2 px-5 font-bold">
            ← Wishlist
          </Link>
        </div>
      </div>
    );
  }

  if (shops.length === 0) return <p className="rounded-xl bg-white p-4" data-testid="compare-empty">{tr(T.none, lang)} ({comparison.radiusKm} km)</p>;

  return (
    <div className="space-y-4" data-testid="compare-view">
      <h2 className="text-lg font-extrabold">{tr(T.ask, lang)}</h2>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Sort">
        {(
          [
            ["TOTAL", T.sortTotal],
            ["NEAREST", T.sortNear],
            ["MOST_ITEMS", T.sortMost],
          ] as const
        ).map(([key, label]) => (
          <button key={key} type="button" role="radio" aria-checked={sort === key} onClick={() => setSort(key)} className={`h-10 rounded-full px-4 text-sm font-semibold ${sort === key ? "bg-ink-900 text-white" : "border bg-white"}`}>
            {tr(label, lang)}
          </button>
        ))}
      </div>
      {error ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      <ul className="grid gap-3 lg:grid-cols-2">
        {shops.map((s) => (
          <li key={s.shopId} className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4" data-testid="compare-shop">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-lg font-extrabold">{s.shopName}</div>
                <div className="text-sm text-ink-600">
                  {s.distanceKm != null ? `${s.distanceKm.toFixed(1)} ${tr(T.km, lang)}` : s.area}
                  {s.rating != null ? ` · ★ ${s.rating.toFixed(1)} (${s.ratingCount})` : ""}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs uppercase text-ink-500">{tr(T.total, lang)}</div>
                <div className="text-xl font-extrabold" data-testid="shop-total">
                  {rupees(s.itemsPaise)}
                </div>
              </div>
            </div>
            <div className="mt-2 text-sm">
              <strong>
                {s.available}/{s.total}
              </strong>{" "}
              {tr(T.items, lang)}
              {s.priceOnConfirmation > 0 ? (
                <span className="ml-2 rounded-full bg-amber-100 px-2 text-xs">
                  {s.priceOnConfirmation} × {tr(T.poc, lang)} ({tr(T.pocNote, lang)})
                </span>
              ) : null}
            </div>
            {s.missing.length > 0 ? (
              <div className="mt-1 text-sm text-red-800">
                {tr(T.missing, lang)}: {s.missing.map((id) => itemNames[id] ?? "?").join(", ")}
              </div>
            ) : null}
            <ul className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {s.deliveryOptions.map((o) => (
                <li key={o.key} className="rounded-full bg-slate-100 px-2.5 py-1">
                  {FULFILMENT_OPTION_LABELS[o.key]} · {o.feePaise === 0 ? tr(T.free, lang) : rupees(o.feePaise)} · ~{o.etaMinutes} {tr(T.eta, lang)}
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => setOpen(open === s.shopId ? null : s.shopId)} className="mt-2 text-sm font-semibold text-kesari-800 underline">
              {tr(T.details, lang)} {open === s.shopId ? "▲" : "▼"}
            </button>
            {open === s.shopId ? (
              <table className="mt-2 w-full text-sm">
                <tbody>
                  {s.items.map((q) => (
                    <tr key={q.itemId} className="border-t">
                      <td className="py-1">
                        {itemNames[q.itemId]}
                        {q.productName && q.productName !== itemNames[q.itemId] ? <div className="text-xs text-ink-500">{q.productName}{q.status === "SIMILAR" ? ` (${tr(T.similar, lang)})` : ""}</div> : null}
                        {q.packNote ? <div className="text-xs text-ink-500">{q.packNote}</div> : null}
                      </td>
                      <td className="py-1 text-right">
                        {q.status === "AVAILABLE" || q.status === "SIMILAR"
                          ? rupees(q.linePaise)
                          : q.status === "PRICE_ON_CONFIRMATION"
                            ? tr(T.poc, lang)
                            : q.status === "LOW_STOCK"
                              ? `Only ${q.stockLeft ?? 0} left`
                              : "✕"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void orderFrom(s)}
              className="mt-3 h-12 w-full rounded-xl bg-kesari-600 font-bold text-white disabled:opacity-50"
              data-testid="order-from-shop"
            >
              {busy === s.shopId ? "…" : tr(T.order, lang)}
            </button>
          </li>
        ))}
      </ul>

      <details className="rounded-2xl bg-white p-3">
        <summary className="cursor-pointer font-bold">{tr(T.grid, lang)}</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full text-sm" data-testid="compare-grid">
            <thead>
              <tr>
                <th className="sticky left-0 bg-white p-2 text-left"> </th>
                {shops.map((s) => (
                  <th key={s.shopId} className="p-2 text-right">
                    {s.shopName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparison.itemIds.map((itemId) => {
                const lines = shops.map((s) => s.items.find((q) => q.itemId === itemId));
                const prices = lines.map((q) => (q && (q.status === "AVAILABLE" || q.status === "SIMILAR") ? q.linePaise : null)).filter((p): p is number => p != null);
                const min = prices.length ? Math.min(...prices) : null;
                return (
                  <tr key={itemId} className="border-t">
                    <td className="sticky left-0 bg-white p-2">{itemNames[itemId]}</td>
                    {lines.map((q, i) => {
                      const price = q && (q.status === "AVAILABLE" || q.status === "SIMILAR") ? q.linePaise : null;
                      return (
                        <td key={shops[i].shopId} className={`p-2 text-right ${price != null && price === min ? "font-bold text-leaf-800" : ""}`}>
                          {price != null ? rupees(price) : q?.status === "PRICE_ON_CONFIRMATION" ? "?" : "—"}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
