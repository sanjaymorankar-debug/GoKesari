"use client";

/**
 * Module 2: the mapping screen. Each item from the shop's software and the
 * GoKesari product it is matched to: confirm a suggestion, search and pick,
 * or ignore. A match applies the item's stock, price and tax at once.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, inputClass } from "@/components/ui";

export interface MappingItem {
  id: string;
  externalId: string;
  externalName: string;
  externalSku: string | null;
  externalBarcode: string | null;
  externalUnit: string | null;
  lastSeen: { stock?: number | null; pricePaise?: number | null; mrpPaise?: number | null; hsn?: string | null; gstRateBp?: number | null };
  matchStatus: "MATCHED" | "SUGGESTED" | "UNMATCHED" | "IGNORED";
  matchMethod: string | null;
  suggestions: { productId: string; name: string; score: number }[];
  product: { id: string; name: string | null; code: string | null } | null;
  listing: { id: string; onlinePricePaise: number | null; onlineStock: number | null } | null;
  lastIssue: string | null;
}

const TABS: [string, string][] = [
  ["", "All"],
  ["SUGGESTED", "Suggested"],
  ["UNMATCHED", "Not matched"],
  ["ISSUE", "Problems"],
  ["MATCHED", "Matched"],
  ["IGNORED", "Ignored"],
];

const rupees = (p: number | null | undefined) => (p == null ? "–" : `₹${(p / 100).toFixed(2)}`);

export function ItemMapping({ shopId, items, total, page, pageSize, status, q }: { shopId: string; items: MappingItem[]; total: number; page: number; pageSize: number; status: string; q: string }) {
  const router = useRouter();
  const base = `/api/shops/${shopId}/integration/items`;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, { id: string; name: string; code: string; listed: boolean }[]>>({});

  const href = (next: { status?: string; page?: number; q?: string }) => {
    const p = new URLSearchParams({ shop: shopId });
    const s = next.status ?? status;
    if (s) p.set("status", s);
    const query = next.q ?? q;
    if (query) p.set("q", query);
    if ((next.page ?? 1) > 1) p.set("page", String(next.page));
    return `/shop/settings/integrations/mapping?${p.toString()}`;
  };

  async function act(item: MappingItem, body: Record<string, unknown>) {
    setBusy(item.id);
    setError(null);
    setNotice(null);
    const res = await fetch(`${base}/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    setBusy(null);
    if (!res.ok) {
      setError(data?.error?.message ?? "Could not save.");
      return;
    }
    if (body.action === "match") {
      setNotice(data?.applied === "issue" ? `${item.externalName} is matched, but there is a problem — see below.` : `${item.externalName} is matched and updated.`);
    }
    router.refresh();
  }

  async function find(item: MappingItem) {
    const term = search[item.id]?.trim() ?? "";
    if (term.length < 2) return;
    const res = await fetch(`${base}/search?q=${encodeURIComponent(term)}`);
    const data = await res.json().catch(() => null);
    setResults({ ...results, [item.id]: data?.products ?? [] });
  }

  async function rematch() {
    setBusy("all");
    const res = await fetch(`${base}/auto-match`, { method: "POST" });
    const data = await res.json().catch(() => null);
    setBusy(null);
    if (res.ok) setNotice(`Matching run again: ${data.matched} matched, ${data.suggested} suggested.`);
    else setError(data?.error?.message ?? "Could not run matching.");
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <div className="flex flex-wrap gap-1">
        {TABS.map(([value, label]) => (
          <a key={value} href={href({ status: value, page: 1 })} className={`rounded-full px-3 py-1 text-sm ${status === value ? "bg-kesari-600 text-white" : "bg-cream-100 text-ink-700"}`}>
            {label}
          </a>
        ))}
      </div>
      <form action="/shop/settings/integrations/mapping" className="flex gap-2">
        <input type="hidden" name="shop" value={shopId} />
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <input name="q" defaultValue={q} placeholder="Search your items" className={inputClass} />
        <Button type="submit" variant="secondary">Search</Button>
        <Button type="button" variant="secondary" disabled={busy === "all"} onClick={() => void rematch()}>Match again</Button>
      </form>
      {items.length === 0 ? <p className="text-sm text-ink-500">No items here.</p> : null}
      {items.map((item) => (
        <Card key={item.id} className="space-y-2 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-medium text-ink-900">{item.externalName}</p>
              <p className="text-xs text-ink-500">
                {[item.externalSku && `Code ${item.externalSku}`, item.externalBarcode && `Barcode ${item.externalBarcode}`, item.externalUnit].filter(Boolean).join(" · ")}
              </p>
              <p className="text-xs text-ink-500">
                Stock {item.lastSeen.stock ?? "–"} · Price {rupees(item.lastSeen.pricePaise)} · MRP {rupees(item.lastSeen.mrpPaise)} · HSN {item.lastSeen.hsn ?? "–"} · GST {item.lastSeen.gstRateBp != null ? `${item.lastSeen.gstRateBp / 100}%` : "–"}
              </p>
            </div>
            <Badge tone={item.matchStatus === "MATCHED" ? "success" : item.matchStatus === "SUGGESTED" ? "info" : item.matchStatus === "IGNORED" ? "neutral" : "warning"}>
              {item.matchStatus === "MATCHED" ? `matched${item.matchMethod ? ` (${item.matchMethod.toLowerCase()})` : ""}` : item.matchStatus.toLowerCase()}
            </Badge>
          </div>
          {item.lastIssue ? <Alert tone="warning">{item.lastIssue}</Alert> : null}
          {item.matchStatus === "MATCHED" && item.product ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                → <b>{item.product.name}</b> {item.listing ? <span className="text-xs text-ink-500">(online {rupees(item.listing.onlinePricePaise)}, stock {item.listing.onlineStock ?? "–"})</span> : null}
              </span>
              <Button size="sm" variant="secondary" disabled={busy === item.id} onClick={() => void act(item, { action: "unmatch" })}>Not this product</Button>
            </div>
          ) : null}
          {item.matchStatus !== "MATCHED" ? (
            <div className="space-y-2">
              {item.suggestions.length ? (
                <div className="flex flex-wrap gap-2">
                  {item.suggestions.slice(0, 3).map((s) => (
                    <Button key={s.productId} size="sm" variant="secondary" disabled={busy === item.id} onClick={() => void act(item, { action: "match", productId: s.productId })}>
                      {s.name} <span className="text-ink-500">({Math.round(s.score * 100)}%)</span>
                    </Button>
                  ))}
                </div>
              ) : null}
              <div className="flex gap-2">
                <input
                  className={inputClass}
                  placeholder="Find the GoKesari product"
                  value={search[item.id] ?? ""}
                  onChange={(e) => setSearch({ ...search, [item.id]: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void find(item);
                    }
                  }}
                />
                <Button size="sm" variant="secondary" onClick={() => void find(item)}>Find</Button>
              </div>
              {results[item.id]?.length ? (
                <ul className="divide-y divide-cream-200 rounded border border-cream-200 text-sm">
                  {results[item.id].map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2 px-2 py-1">
                      <span>{p.name} <span className="text-xs text-ink-500">{p.code}{p.listed ? " · in your shop" : ""}</span></span>
                      <Button size="sm" disabled={busy === item.id} onClick={() => void act(item, { action: "match", productId: p.id })}>Match</Button>
                    </li>
                  ))}
                </ul>
              ) : results[item.id] ? <p className="text-xs text-ink-500">No product found. GoKesari support can add it to the catalogue.</p> : null}
              {item.matchStatus !== "IGNORED" ? (
                <Button size="sm" variant="ghost" disabled={busy === item.id} onClick={() => void act(item, { action: "ignore" })}>Ignore — not sold on GoKesari</Button>
              ) : (
                <Button size="sm" variant="ghost" disabled={busy === item.id} onClick={() => void act(item, { action: "unmatch" })}>Stop ignoring</Button>
              )}
            </div>
          ) : null}
        </Card>
      ))}
      {total > pageSize ? (
        <div className="flex justify-between text-sm">
          {page > 1 ? <a href={href({ page: page - 1 })} className="text-kesari-600">← Previous</a> : <span />}
          <span className="text-ink-500">Page {page} of {Math.ceil(total / pageSize)}</span>
          {page * pageSize < total ? <a href={href({ page: page + 1 })} className="text-kesari-600">Next →</a> : <span />}
        </div>
      ) : null}
    </div>
  );
}
