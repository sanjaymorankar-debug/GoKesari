"use client";

/**
 * Shop owner's Puja Samagri screen (docs/puja-samagri-2026-11, brief §5). One screen, tabs on top:
 *   Take catalogue · Browse & add · New type / product · Removed · Price requests
 * Stock, price, shop-only MRP, discount, photos and the inline grid stay on the existing
 * "My products" screen; Excel / CSV on the existing bulk upload — linked from here.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PUJA_FESTIVALS, PUJA_UNITS, formatIst } from "@/lib/puja";

import { useLoad } from "./use-load";

type Tab = "setup" | "browse" | "create" | "removed" | "prices";

interface Category {
  id: string;
  slug: string;
  name: string;
  nameHi: string;
  nameMr: string;
  emoji: string;
  productCount: number;
  listed: number;
}
interface TypeRow {
  id: string;
  categoryId: string;
  name: string;
  nameHi: string | null;
  nameMr: string | null;
  approvalStatus: string;
  ownedByShop: boolean;
  defaultUnit: string | null;
}
interface Setup {
  shop: { id: string; name: string; shopType: string };
  typeEnabled: boolean;
  isPujaShop: boolean;
  primaryIsPuja: boolean;
  defaultStock: number;
  categories: Category[];
  types: TypeRow[];
}
interface Item {
  productId: string;
  name: string;
  nameHi: string | null;
  nameMr: string | null;
  categoryId: string;
  typeName: string | null;
  kind: "PACKAGED" | "LOOSE";
  mrpPaise: number | null;
  festivals: string[];
  approvalStatus: string;
  listing: { id: string; state: "LISTED" | "REMOVED"; pricePaise: number | null; stock: number } | null;
}
interface Match {
  id: string;
  name: string;
  distance: number;
  status: string;
}

const rupees = (p: number | null | undefined) => (p == null ? "—" : `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const btn = "min-h-10 rounded-xl px-3 text-sm font-semibold disabled:bg-cream-200 disabled:text-ink-600";
const primary = `${btn} bg-kesari-600 text-white hover:bg-kesari-800`;
const secondary = `${btn} border border-cream-200 bg-white text-ink-800 hover:bg-cream-100`;
const input = "mt-1 min-h-10 w-full rounded-lg border border-cream-200 px-2 text-sm";

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string; details?: Record<string, unknown> }> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, message: body?.error?.message ?? "Something went wrong. Please try again.", details: body?.error?.details };
  return { ok: true, data: body as T };
}

function Notice({ tone, children }: { tone: "ok" | "warn" | "error"; children: React.ReactNode }) {
  const cls = tone === "ok" ? "bg-green-50 text-green-900" : tone === "warn" ? "bg-amber-50 text-amber-900" : "bg-red-50 text-red-800";
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-xl px-3 py-2 text-sm ${cls}`}>
      {children}
    </div>
  );
}

export function PujaShopManager({ shopId, initialTab, myProductsHref, bulkHref }: { shopId: string; initialTab: Tab; myProductsHref: string; bulkHref: string }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await api<Setup>(`/api/shops/${shopId}/puja`);
    if (r.ok) setSetup(r.data);
    else setLoadError(r.message);
  }, [shopId]);
  useLoad(reload);

  const tabs: { key: Tab; label: string }[] = [
    { key: "setup", label: "Take catalogue" },
    { key: "browse", label: "Browse & add" },
    { key: "create", label: "New type / product" },
    { key: "removed", label: "Removed" },
    { key: "prices", label: "Price requests" },
  ];

  return (
    <div className="space-y-3" data-testid="puja-shop-manager">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Puja Samagri">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => {
              setTab(t.key);
              router.replace(`?tab=${t.key}`, { scroll: false });
            }}
            className={`min-h-10 rounded-full border px-3 text-sm font-semibold ${tab === t.key ? "border-kesari-600 bg-kesari-600 text-white" : "border-cream-200 bg-white text-ink-800"}`}
            data-testid={`puja-tab-${t.key}`}
          >
            {t.label}
          </button>
        ))}
        <Link href={myProductsHref} className="inline-flex min-h-10 items-center rounded-full border border-cream-200 bg-white px-3 text-sm font-semibold text-ink-800">
          Stock, price & MRP →
        </Link>
        <Link href={bulkHref} className="inline-flex min-h-10 items-center rounded-full border border-cream-200 bg-white px-3 text-sm font-semibold text-ink-800">
          Excel / CSV →
        </Link>
      </div>
      {loadError ? <Notice tone="error">{loadError}</Notice> : null}
      {!setup ? (
        <p className="text-sm text-ink-700">Loading…</p>
      ) : !setup.typeEnabled ? (
        <Notice tone="warn">The Puja Samagri shop type is switched off by GoKesari for now.</Notice>
      ) : tab === "setup" ? (
        <SetupTab shopId={shopId} setup={setup} onDone={reload} />
      ) : tab === "browse" ? (
        <BrowseTab shopId={shopId} setup={setup} onDone={reload} />
      ) : tab === "create" ? (
        <CreateTab shopId={shopId} setup={setup} onDone={reload} />
      ) : tab === "removed" ? (
        <RemovedTab shopId={shopId} />
      ) : (
        <PricesTab shopId={shopId} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- take catalogue */

function SetupTab({ shopId, setup, onDone }: { shopId: string; setup: Setup; onDone: () => Promise<void> }) {
  const [excludedCats, setExcludedCats] = useState<Set<string>>(new Set());
  const [excludedProducts, setExcludedProducts] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [items, setItems] = useState<Record<string, Item[]>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const total = setup.categories.filter((c) => !excludedCats.has(c.id)).reduce((n, c) => n + c.productCount, 0);
  const toAdd = Math.max(0, total - excludedProducts.size);
  const listedTotal = setup.categories.reduce((n, c) => n + c.listed, 0);

  async function expand(categoryId: string) {
    setOpen(open === categoryId ? null : categoryId);
    if (!items[categoryId]) {
      const r = await api<{ items: Item[] }>(`/api/shops/${shopId}/puja/catalogue?categoryId=${categoryId}&limit=200`);
      if (r.ok) setItems((m) => ({ ...m, [categoryId]: r.data.items }));
    }
  }
  async function take() {
    setBusy(true);
    setError(null);
    setResult(null);
    const r = await api<{ added: number; needsPrice: number; alreadyListed: number; previouslyRemoved: number; stock: number; addedType: boolean }>(
      `/api/shops/${shopId}/puja/seed`,
      { method: "POST", body: JSON.stringify({ excludeCategoryIds: [...excludedCats], excludeProductIds: [...excludedProducts] }) },
    );
    setBusy(false);
    if (!r.ok) return setError(r.message);
    const d = r.data;
    setResult(
      `${d.added} products added at stock ${d.stock}.` +
        (d.needsPrice ? ` ${d.needsPrice} loose or unpriced items wait for your price.` : "") +
        (d.alreadyListed ? ` ${d.alreadyListed} were already in your shop.` : "") +
        (d.previouslyRemoved ? ` ${d.previouslyRemoved} you removed earlier stay removed (see Removed).` : "") +
        (d.addedType ? " Puja Samagri is now an added shop type of your shop." : ""),
    );
    await onDone();
  }

  return (
    <div className="space-y-3" data-testid="puja-setup">
      <p className="text-sm text-ink-800">
        Every product of the ticked categories goes into your shop with <b>stock {setup.defaultStock}</b>, priced at its MRP. Loose items (flowers, loose kapur…) and items
        without an MRP are added with an <b>empty price</b> — set it on “Stock, price & MRP”. Untick categories or open one to untick products.
        {listedTotal ? ` You already list ${listedTotal} puja products; they are skipped.` : ""}
        {!setup.primaryIsPuja ? " Your shop's main type stays as it is; Puja Samagri is added as an extra type." : ""}
      </p>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {setup.categories.map((c) => {
          const on = !excludedCats.has(c.id);
          return (
            <li key={c.id} className="rounded-xl border border-cream-200 bg-white p-2">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  checked={on}
                  aria-label={`Include ${c.name}`}
                  onChange={() =>
                    setExcludedCats((s) => {
                      const n = new Set(s);
                      if (n.has(c.id)) n.delete(c.id);
                      else n.add(c.id);
                      return n;
                    })
                  }
                  data-testid="puja-setup-category"
                />
                <button type="button" onClick={() => expand(c.id)} className="flex min-h-10 flex-1 items-center justify-between gap-2 text-left text-sm">
                  <span>
                    {c.emoji} <b>{c.name}</b> <span className="text-ink-600">· {c.nameHi}</span>
                  </span>
                  <span className="whitespace-nowrap text-xs text-ink-700">
                    {c.productCount} items{c.listed ? ` · ${c.listed} listed` : ""} {open === c.id ? "▲" : "▼"}
                  </span>
                </button>
              </div>
              {open === c.id ? (
                <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto border-t border-cream-100 pt-2">
                  {(items[c.id] ?? []).map((i) => (
                    <li key={i.productId} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        disabled={!on || Boolean(i.listing)}
                        checked={on && !excludedProducts.has(i.productId) && !i.listing}
                        onChange={() =>
                          setExcludedProducts((s) => {
                            const n = new Set(s);
                            if (n.has(i.productId)) n.delete(i.productId);
                            else n.add(i.productId);
                            return n;
                          })
                        }
                        aria-label={i.name}
                      />
                      <span className="min-w-0 flex-1 truncate">{i.name}</span>
                      <span className="whitespace-nowrap text-xs text-ink-600">{i.listing ? (i.listing.state === "LISTED" ? "in shop" : "removed") : i.kind === "LOOSE" || i.mrpPaise == null ? "price: you set" : rupees(i.mrpPaise)}</span>
                    </li>
                  ))}
                  {!items[c.id] ? <li className="text-xs text-ink-600">Loading…</li> : null}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy || toAdd === 0} onClick={take} className={primary} data-testid="puja-setup-take">
          {busy ? "Adding…" : `Add up to ${toAdd} products at stock ${setup.defaultStock}`}
        </button>
        <span className="text-xs text-ink-700">Safe to press again later: only new catalogue products are added.</span>
      </div>
      {result ? <Notice tone="ok">{result}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}

/* ------------------------------------------------------------- browse & add */

function BrowseTab({ shopId, setup, onDone }: { shopId: string; setup: Setup; onDone: () => Promise<void> }) {
  const [filters, setFilters] = useState({ categoryId: "", typeId: "", festival: "", kind: "", q: "", notListed: true });
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "120" });
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v === true ? "1" : String(v));
    const r = await api<{ items: Item[]; total: number }>(`/api/shops/${shopId}/puja/catalogue?${params}`);
    if (r.ok) {
      setItems(r.data.items);
      setTotal(r.data.total);
    }
  }, [filters, shopId]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  const types = setup.types.filter((t) => !filters.categoryId || t.categoryId === filters.categoryId);
  async function add() {
    setBusy(true);
    setMessage(null);
    const r = await api<{ added: number; needsPrice: number; stock: number }>(`/api/shops/${shopId}/puja/seed`, {
      method: "POST",
      body: JSON.stringify({ onlyProductIds: [...picked] }),
    });
    setBusy(false);
    if (!r.ok) return setMessage({ tone: "error", text: r.message });
    setMessage({ tone: "ok", text: `${r.data.added} added at stock ${r.data.stock}${r.data.needsPrice ? ` (${r.data.needsPrice} need your price)` : ""}.` });
    setPicked(new Set());
    await Promise.all([load(), onDone()]);
  }

  return (
    <div className="space-y-3" data-testid="puja-browse">
      <div className="grid grid-cols-2 gap-2 rounded-xl border border-cream-200 bg-white p-2 sm:grid-cols-6">
        <label className="col-span-2 text-xs font-medium text-ink-700">
          Search (English, हिंदी, मराठी, synonyms)
          <input value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} className={input} placeholder="kapur, मोमबत्ती, kumkum…" data-testid="puja-browse-q" />
        </label>
        <label className="text-xs font-medium text-ink-700">
          Category
          <select value={filters.categoryId} onChange={(e) => setFilters({ ...filters, categoryId: e.target.value, typeId: "" })} className={input}>
            <option value="">All</option>
            {setup.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-ink-700">
          Product type
          <select value={filters.typeId} onChange={(e) => setFilters({ ...filters, typeId: e.target.value })} className={input}>
            <option value="">All</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.ownedByShop ? " (yours)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-ink-700">
          Festival
          <select value={filters.festival} onChange={(e) => setFilters({ ...filters, festival: e.target.value })} className={input}>
            <option value="">Any</option>
            {PUJA_FESTIVALS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.en}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-ink-700">
          Loose / packed
          <select value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value })} className={input}>
            <option value="">Both</option>
            <option value="packed">Packed</option>
            <option value="loose">Loose</option>
          </select>
        </label>
        <label className="col-span-2 flex min-h-10 items-center gap-2 text-sm text-ink-800 sm:col-span-6">
          <input type="checkbox" checked={filters.notListed} onChange={(e) => setFilters({ ...filters, notListed: e.target.checked })} className="h-4 w-4" /> Only products not in my shop
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-700">{total} found</span>
        <button type="button" className={secondary} onClick={() => setPicked(new Set(items.filter((i) => !i.listing).map((i) => i.productId)))}>
          Tick all shown
        </button>
        <button type="button" className={primary} disabled={busy || picked.size === 0} onClick={add} data-testid="puja-browse-add">
          {busy ? "Adding…" : `Add ${picked.size} to my shop`}
        </button>
      </div>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <ul className="divide-y divide-cream-100 rounded-xl border border-cream-200 bg-white">
        {items.map((i) => (
          <li key={i.productId} className="flex items-center gap-2 px-2 py-1.5 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              disabled={Boolean(i.listing)}
              checked={picked.has(i.productId)}
              onChange={() =>
                setPicked((s) => {
                  const n = new Set(s);
                  if (n.has(i.productId)) n.delete(i.productId);
                  else n.add(i.productId);
                  return n;
                })
              }
              aria-label={i.name}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-ink-900">{i.name}</span>
              <span className="block truncate text-xs text-ink-600">
                {[i.nameHi, i.nameMr, i.typeName].filter(Boolean).join(" · ")}
                {i.approvalStatus === "PENDING_APPROVAL" ? " · your product, in review" : ""}
              </span>
            </span>
            <span className="whitespace-nowrap text-xs text-ink-700">
              {i.listing ? (i.listing.state === "LISTED" ? `in shop · ${rupees(i.listing.pricePaise)}` : "removed") : i.kind === "LOOSE" ? "loose" : rupees(i.mrpPaise)}
            </span>
          </li>
        ))}
        {items.length === 0 ? <li className="px-2 py-3 text-sm text-ink-600">Nothing matches.</li> : null}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------- new type / product */

function Matches({ matches, onUse }: { matches: Match[]; onUse?: (m: Match) => void }) {
  return (
    <ul className="mt-1 space-y-1" data-testid="puja-duplicate-matches">
      {matches.map((m) => (
        <li key={m.id} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2 py-1 text-sm">
          <span>
            {m.name} <span className="text-xs text-ink-600">{m.distance === 0 ? "same name" : "close match"}</span>
          </span>
          {onUse ? (
            <button type="button" className="text-xs font-semibold text-kesari-800 underline" onClick={() => onUse(m)}>
              Use this
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function CreateTab({ shopId, setup, onDone }: { shopId: string; setup: Setup; onDone: () => Promise<void> }) {
  const firstCat = setup.categories[0]?.id ?? "";
  const [type, setType] = useState({ categoryId: firstCat, name: "", nameHi: "", nameMr: "", unit: "pcs", variantAttributes: "", loose: false, perishable: false, edible: false });
  const [typeMsg, setTypeMsg] = useState<{ tone: "ok" | "warn" | "error"; text: string; matches?: Match[] } | null>(null);
  const [prod, setProd] = useState({ categoryId: firstCat, typeId: "", name: "", nameHi: "", nameMr: "", synonyms: "", unit: "pcs", loose: false, perishable: false, edible: false, description: "", festivals: [] as string[] });
  const [variants, setVariants] = useState([{ label: "", mrp: "", price: "", stock: "100" }]);
  const [prodMsg, setProdMsg] = useState<{ tone: "ok" | "warn" | "error"; text: string; matches?: Match[]; listings?: { listingId: string; name: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const types = useMemo(() => setup.types.filter((t) => t.categoryId === prod.categoryId), [setup.types, prod.categoryId]);
  const toPaise = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 100));

  async function saveType(confirmDuplicate = false) {
    setBusy(true);
    setTypeMsg(null);
    const r = await api<{ type: { id: string; name: string; approvalStatus: string } }>(`/api/shops/${shopId}/puja/types`, {
      method: "POST",
      body: JSON.stringify({
        ...type,
        nameHi: type.nameHi || null,
        nameMr: type.nameMr || null,
        variantAttributes: type.variantAttributes.split(",").map((s) => s.trim()).filter(Boolean),
        confirmDuplicate,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      const matches = (r.details?.matches as Match[] | undefined) ?? undefined;
      return setTypeMsg({ tone: r.status === 409 ? "warn" : "error", text: r.message, matches });
    }
    setTypeMsg({ tone: "ok", text: `“${r.data.type.name}” created — you can use it now. It is sent to GoKesari for the master catalogue.` });
    setType({ ...type, name: "", nameHi: "", nameMr: "", variantAttributes: "" });
    await onDone();
  }

  async function saveProduct(confirmDuplicate = false) {
    setBusy(true);
    setProdMsg(null);
    const r = await api<{ created: { listingId: string; name: string; reused: boolean }[] }>(`/api/shops/${shopId}/puja/products`, {
      method: "POST",
      body: JSON.stringify({
        categoryId: prod.categoryId,
        typeId: prod.typeId || null,
        name: prod.name,
        nameHi: prod.nameHi || null,
        nameMr: prod.nameMr || null,
        synonyms: prod.synonyms.split(",").map((s) => s.trim()).filter(Boolean),
        unit: prod.unit,
        loose: prod.loose,
        perishable: prod.perishable,
        edible: prod.edible,
        description: prod.description || null,
        festivals: prod.festivals,
        variants: variants.map((v) => ({ label: v.label || null, mrpPaise: toPaise(v.mrp), pricePaise: toPaise(v.price), stock: Number(v.stock) || 0 })),
        confirmDuplicate,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      const matches = (r.details?.matches as Match[] | undefined) ?? undefined;
      return setProdMsg({ tone: r.status === 409 ? "warn" : "error", text: r.message, matches });
    }
    setProdMsg({
      tone: "ok",
      text: `${r.data.created.length} product${r.data.created.length === 1 ? "" : "s"} added to your shop and sent for review. Add photos:`,
      listings: r.data.created.map((c) => ({ listingId: c.listingId, name: c.name })),
    });
    setProd({ ...prod, name: "", nameHi: "", nameMr: "", synonyms: "", description: "" });
    setVariants([{ label: "", mrp: "", price: "", stock: "100" }]);
    await onDone();
  }

  const flag = (checked: boolean, onChange: (v: boolean) => void, label: string) => (
    <label className="flex min-h-10 items-center gap-2 text-sm text-ink-800">
      <input type="checkbox" className="h-4 w-4" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <section className="space-y-2 rounded-xl border border-cream-200 bg-white p-3" data-testid="puja-new-type">
        <h2 className="text-base font-bold text-ink-900">New product type</h2>
        <p className="text-xs text-ink-700">When a type is missing (e.g. “Pooja Chunni”). The duplicate check runs first.</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="col-span-2 text-xs font-medium text-ink-700">
            Category
            <select value={type.categoryId} onChange={(e) => setType({ ...type, categoryId: e.target.value })} className={input}>
              {setup.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2 text-xs font-medium text-ink-700">
            Name (English)
            <input value={type.name} onChange={(e) => setType({ ...type, name: e.target.value })} className={input} data-testid="puja-type-name" />
          </label>
          <label className="text-xs font-medium text-ink-700">
            हिंदी नाम
            <input value={type.nameHi} onChange={(e) => setType({ ...type, nameHi: e.target.value })} className={input} />
          </label>
          <label className="text-xs font-medium text-ink-700">
            मराठी नाव
            <input value={type.nameMr} onChange={(e) => setType({ ...type, nameMr: e.target.value })} className={input} />
          </label>
          <label className="text-xs font-medium text-ink-700">
            Unit
            <select value={type.unit} onChange={(e) => setType({ ...type, unit: e.target.value })} className={input}>
              {PUJA_UNITS.map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-ink-700">
            Variants by (comma)
            <input value={type.variantAttributes} onChange={(e) => setType({ ...type, variantAttributes: e.target.value })} className={input} placeholder="size, colour" />
          </label>
        </div>
        <div className="flex flex-wrap gap-3">
          {flag(type.loose, (v) => setType({ ...type, loose: v }), "Loose")}
          {flag(type.perishable, (v) => setType({ ...type, perishable: v }), "Perishable")}
          {flag(type.edible, (v) => setType({ ...type, edible: v }), "Edible")}
        </div>
        <button type="button" className={primary} disabled={busy || type.name.trim().length < 2} onClick={() => saveType(false)} data-testid="puja-type-save">
          Create type
        </button>
        {typeMsg ? (
          <Notice tone={typeMsg.tone}>
            {typeMsg.text}
            {typeMsg.matches?.length ? <Matches matches={typeMsg.matches} /> : null}
            {typeMsg.tone === "warn" && !typeMsg.matches?.some((m) => m.distance === 0) ? (
              <button type="button" className="mt-2 text-sm font-semibold underline" onClick={() => saveType(true)} data-testid="puja-type-confirm">
                Create “{type.name}” anyway
              </button>
            ) : null}
          </Notice>
        ) : null}
      </section>

      <section className="space-y-2 rounded-xl border border-cream-200 bg-white p-3" data-testid="puja-new-product">
        <h2 className="text-base font-bold text-ink-900">New product</h2>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs font-medium text-ink-700">
            Category
            <select value={prod.categoryId} onChange={(e) => setProd({ ...prod, categoryId: e.target.value, typeId: "" })} className={input}>
              {setup.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-ink-700">
            Product type
            <select value={prod.typeId} onChange={(e) => setProd({ ...prod, typeId: e.target.value })} className={input}>
              <option value="">—</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.ownedByShop ? " (yours)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2 text-xs font-medium text-ink-700">
            Name (English)
            <input value={prod.name} onChange={(e) => setProd({ ...prod, name: e.target.value })} className={input} data-testid="puja-product-name" />
          </label>
          <label className="text-xs font-medium text-ink-700">
            हिंदी नाम
            <input value={prod.nameHi} onChange={(e) => setProd({ ...prod, nameHi: e.target.value })} className={input} />
          </label>
          <label className="text-xs font-medium text-ink-700">
            मराठी नाव
            <input value={prod.nameMr} onChange={(e) => setProd({ ...prod, nameMr: e.target.value })} className={input} />
          </label>
          <label className="text-xs font-medium text-ink-700">
            Unit
            <select value={prod.unit} onChange={(e) => setProd({ ...prod, unit: e.target.value })} className={input}>
              {PUJA_UNITS.map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-ink-700">
            Other names (comma)
            <input value={prod.synonyms} onChange={(e) => setProd({ ...prod, synonyms: e.target.value })} className={input} />
          </label>
        </div>
        <div className="flex flex-wrap gap-3">
          {flag(prod.loose, (v) => setProd({ ...prod, loose: v }), "Loose")}
          {flag(prod.perishable, (v) => setProd({ ...prod, perishable: v }), "Perishable")}
          {flag(prod.edible, (v) => setProd({ ...prod, edible: v }), "Edible")}
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-700">
              <th className="font-medium">Variant (size / pack)</th>
              <th className="font-medium">MRP ₹</th>
              <th className="font-medium">Price ₹</th>
              <th className="font-medium">Stock</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {variants.map((v, i) => (
              <tr key={i}>
                {(["label", "mrp", "price", "stock"] as const).map((k) => (
                  <td key={k} className="pr-1">
                    <input
                      value={v[k]}
                      disabled={k === "mrp" && prod.loose}
                      inputMode={k === "label" ? "text" : "decimal"}
                      onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))}
                      className="min-h-9 w-full rounded-lg border border-cream-200 px-2 text-sm"
                      aria-label={`${k} ${i + 1}`}
                    />
                  </td>
                ))}
                <td>
                  {variants.length > 1 ? (
                    <button type="button" aria-label="Remove variant" className="px-2 text-ink-600" onClick={() => setVariants(variants.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondary} disabled={variants.length >= 12} onClick={() => setVariants([...variants, { label: "", mrp: "", price: "", stock: "100" }])}>
            + Variant
          </button>
          <button type="button" className={primary} disabled={busy || prod.name.trim().length < 2} onClick={() => saveProduct(false)} data-testid="puja-product-save">
            Add to my shop
          </button>
        </div>
        {prodMsg ? (
          <Notice tone={prodMsg.tone}>
            {prodMsg.text}
            {prodMsg.listings ? (
              <ul className="mt-1 list-disc pl-5">
                {prodMsg.listings.map((l) => (
                  <li key={l.listingId}>
                    <Link className="underline" href={`/shop/products/${l.listingId}/media`}>
                      {l.name}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
            {prodMsg.matches?.length ? <Matches matches={prodMsg.matches} /> : null}
            {prodMsg.tone === "warn" ? (
              <button type="button" className="mt-2 text-sm font-semibold underline" onClick={() => saveProduct(true)} data-testid="puja-product-confirm">
                Create mine anyway
              </button>
            ) : null}
          </Notice>
        ) : null}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ removed */

function RemovedTab({ shopId }: { shopId: string }) {
  const [rows, setRows] = useState<{ id: string; name: string; categoryName: string; removedAt: string; pricePaise: number | null; stock: number }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const load = useCallback(async () => {
    const r = await api<{ listings: typeof rows }>(`/api/shops/${shopId}/removed-listings`);
    if (r.ok) setRows(r.data.listings ?? []);
  }, [shopId]);
  useLoad(load);
  async function restore(ids: string[]) {
    const r = await api<{ restored: number }>(`/api/shops/${shopId}/removed-listings`, { method: "POST", body: JSON.stringify({ listingIds: ids }) });
    if (!r.ok) return setMessage({ tone: "error", text: r.message });
    setMessage({ tone: "ok", text: `${r.data.restored} restored with their price, stock and order history.` });
    setPicked(new Set());
    await load();
  }
  if (!rows) return <p className="text-sm text-ink-700">Loading…</p>;
  return (
    <div className="space-y-2" data-testid="puja-removed">
      <p className="text-sm text-ink-800">Products you removed (any category). Order history is never deleted; restore brings a product back as it was.</p>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {rows.length === 0 ? (
        <p className="text-sm text-ink-600">Nothing removed.</p>
      ) : (
        <>
          <button type="button" className={primary} disabled={picked.size === 0} onClick={() => restore([...picked])} data-testid="puja-restore">
            Restore {picked.size || ""}
          </button>
          <ul className="divide-y divide-cream-100 rounded-xl border border-cream-200 bg-white">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={picked.has(r.id)}
                  onChange={() =>
                    setPicked((s) => {
                      const n = new Set(s);
                      if (n.has(r.id)) n.delete(r.id);
                      else n.add(r.id);
                      return n;
                    })
                  }
                  aria-label={r.name}
                />
                <span className="min-w-0 flex-1 truncate">
                  {r.name} <span className="text-xs text-ink-600">· {r.categoryName}</span>
                </span>
                <span className="whitespace-nowrap text-xs text-ink-600">removed {formatIst(r.removedAt)}</span>
                <button type="button" className="text-xs font-semibold text-kesari-800 underline" onClick={() => restore([r.id])}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ price requests */

function PricesTab({ shopId }: { shopId: string }) {
  const [rows, setRows] = useState<
    { id: string; productName: string; unit: string; customerName: string | null; quantity: number | null; note: string | null; createdAt: string }[] | null
  >(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const load = useCallback(async () => {
    const r = await api<{ requests: typeof rows }>(`/api/shops/${shopId}/listing-price-requests`);
    if (r.ok) setRows(r.data.requests ?? []);
  }, [shopId]);
  useLoad(load);
  async function answer(id: string, decline = false) {
    const price = Math.round(Number(prices[id]) * 100);
    const r = await api<{ customers: number }>(`/api/shops/${shopId}/listing-price-requests/${id}`, {
      method: "POST",
      body: JSON.stringify(decline ? { decline: true } : { pricePaise: price }),
    });
    if (!r.ok) return setMessage({ tone: "error", text: r.message });
    setMessage({ tone: "ok", text: decline ? "Declined; the customer is told." : `Price set and on sale; ${r.data.customers} customer(s) told.` });
    await load();
  }
  if (!rows) return <p className="text-sm text-ink-700">Loading…</p>;
  return (
    <div className="space-y-2" data-testid="puja-prices">
      <p className="text-sm text-ink-800">Customers asking the price of loose or fresh items without a price. Your answer becomes the item&apos;s price, so they can order it.</p>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {rows.length === 0 ? <p className="text-sm text-ink-600">No open requests.</p> : null}
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-end gap-2 rounded-xl border border-cream-200 bg-white p-2 text-sm">
            <span className="min-w-0 flex-1">
              <b>{r.productName}</b>
              <span className="block text-xs text-ink-600">
                {r.customerName ?? "Customer"} · {r.quantity ? `${r.quantity} ${r.unit} · ` : ""}
                {formatIst(r.createdAt)}
                {r.note ? ` · “${r.note}”` : ""}
              </span>
            </span>
            <label className="text-xs font-medium text-ink-700">
              Price per {r.unit} ₹
              <input value={prices[r.id] ?? ""} onChange={(e) => setPrices({ ...prices, [r.id]: e.target.value })} inputMode="decimal" className="mt-1 min-h-10 w-28 rounded-lg border border-cream-200 px-2" />
            </label>
            <button type="button" className={primary} disabled={!(Number(prices[r.id]) > 0)} onClick={() => answer(r.id)}>
              Set price
            </button>
            <button type="button" className={secondary} onClick={() => answer(r.id, true)}>
              Not available
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The "take the puja catalogue" step on its own, for the registration wizard's "Add your
 * products" step of a Puja Samagri shop (instead of the 100-product starter shelf).
 */
export function PujaCatalogueSetup({ shopId, onDone }: { shopId: string; onDone: () => Promise<void> }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const r = await api<Setup>(`/api/shops/${shopId}/puja`);
    if (r.ok) setSetup(r.data);
    else setError(r.message);
  }, [shopId]);
  useLoad(reload);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!setup) return <p className="text-sm text-ink-700">Loading the puja catalogue…</p>;
  return (
    <SetupTab
      shopId={shopId}
      setup={setup}
      onDone={async () => {
        await reload();
        await onDone();
      }}
    />
  );
}
