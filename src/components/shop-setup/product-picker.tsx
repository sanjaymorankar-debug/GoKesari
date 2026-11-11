"use client";

/**
 * Step 2, on screen: the master products of the chosen categories, one
 * category tab at a time, with a running count of what is selected.
 */
import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { postJson } from "@/components/save-changes-bar";
import { Alert, Badge, Button, EmptyState, inputClass } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import type { PickerProduct } from "@/server/services/shop-product-setup";

interface Tab {
  id: string;
  name: string;
  productCount: number;
}

export function ProductPicker({
  shopId,
  categories,
  newProducts,
  nextHref,
  addProductHref,
}: {
  shopId: string;
  categories: Tab[];
  newProducts: number;
  nextHref: string;
  addProductHref: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [newOnly, setNewOnly] = useState(false);
  const [rows, setRows] = useState<PickerProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const params = useCallback(
    (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams(extra);
      if (query) p.set("q", query);
      if (categoryId) p.set("category", categoryId);
      if (newOnly) p.set("newOnly", "1");
      return p.toString();
    },
    [query, categoryId, newOnly],
  );

  const load = useCallback(
    async (offset: number) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/shops/${shopId}/product-setup/products?${params({ offset: String(offset) })}`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error?.message ?? "Could not load products.");
        if (id !== requestId.current) return;
        setRows((current) => (offset ? [...current, ...payload.products] : payload.products));
        setTotal(payload.total);
      } catch (e) {
        if (id === requestId.current) setError(e instanceof Error ? e.message : "Could not load products.");
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [shopId, params],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads from the server; state is set after the await
    void load(0);
  }, [load]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  async function selectAll() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/shops/${shopId}/product-setup/products?${params({ ids: "1" })}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "Could not select the products.");
      setSelected((current) => new Set([...current, ...(payload.ids as string[])]));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not select the products.");
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/shops/${shopId}/product-setup/products`, "POST", { productIds: [...selected] });
      router.push(nextHref);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  }

  const filtering = Boolean(query || newOnly);
  const activeCategory = categories.find((c) => c.id === categoryId);

  return (
    <div className="space-y-4">
      {newProducts > 0 ? (
        <Alert tone="info" title="New products available">
          {newProducts} new {newProducts === 1 ? "product was" : "products were"} added to your categories. They are not in your shop until you select them.
          <button type="button" className="ml-2 font-medium underline" onClick={() => setNewOnly((v) => !v)}>
            {newOnly ? "Show all products" : "Show new products"}
          </button>
        </Alert>
      ) : null}

      <form
        role="search"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(draft.trim());
        }}
      >
        <label className="min-w-48 flex-1 text-sm text-ink-700">
          Search
          <input className={inputClass} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Name, brand or product ID" />
        </label>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      <label className="block text-sm text-ink-700 md:hidden">
        Category
        <select className={inputClass} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">All my categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <div className="hidden flex-wrap gap-2 md:flex" role="tablist" aria-label="Categories">
        {[{ id: "", name: "All my categories" }, ...categories].map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === categoryId}
            onClick={() => setCategoryId(c.id)}
            className={clsx("min-h-11 rounded-full px-4 text-sm font-medium", c.id === categoryId ? "bg-kesari-600 text-white" : "bg-cream-100 text-ink-700")}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-500" data-testid="picker-total">
          {total} product{total === 1 ? "" : "s"}
        </span>
        {total > 0 ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={selectAll}>
            {activeCategory && !filtering ? "Select all in this category" : "Select all results"}
          </Button>
        ) : null}
        {selected.size > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        ) : null}
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {!loading && rows.length === 0 ? (
        filtering ? (
          <EmptyState
            title="No products match"
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setDraft("");
                  setQuery("");
                  setNewOnly(false);
                }}
              >
                Clear search
              </Button>
            }
          />
        ) : (
          <EmptyState title="No products here yet." />
        )
      ) : (
        <ul className="divide-y divide-cream-100 rounded-2xl border border-cream-200 bg-white" data-testid="picker-list">
          {rows.map((p) => (
            <li key={p.id}>
              <label className={clsx("flex min-h-16 items-center gap-3 p-3", p.alreadyAdded ? "opacity-70" : "cursor-pointer")}>
                <input
                  type="checkbox"
                  className="size-5 shrink-0 accent-kesari-600"
                  disabled={p.alreadyAdded}
                  checked={p.alreadyAdded || selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  aria-label={`Select ${p.name}`}
                />
                {p.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.imageUrl} alt="" className="size-12 shrink-0 rounded-lg object-cover" loading="lazy" />
                ) : (
                  <span className="size-12 shrink-0 rounded-lg bg-cream-100" aria-hidden />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-ink-900">{p.name}</span>
                  <span className="block text-xs text-ink-500">
                    {[p.brandName, p.packSize, p.code].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="shrink-0 text-right text-sm">
                  <span className="block text-ink-700">{p.mrpPaise != null ? `MRP ${formatPaise(p.mrpPaise)}` : "No MRP"}</span>
                  {p.alreadyAdded ? <Badge tone="neutral">Already added</Badge> : p.isNew ? <Badge tone="success">New</Badge> : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {rows.length < total ? (
        <div className="text-center">
          <Button variant="secondary" disabled={loading} onClick={() => load(rows.length)}>
            {loading ? "Loading…" : "Show more"}
          </Button>
        </div>
      ) : loading ? (
        <p className="text-center text-sm text-ink-500" role="status">
          Loading products…
        </p>
      ) : null}

      <p className="text-sm text-ink-700">
        Can&apos;t find your product?{" "}
        <Link href={addProductHref} className="font-medium text-kesari-700 underline">
          Add a new product
        </Link>
      </p>

      <div className="sticky bottom-0 z-20 -mx-4 border-t border-cream-200 bg-white p-3 sm:mx-0 sm:rounded-xl sm:border">
        <Button className="w-full" disabled={busy || selected.size === 0} onClick={next}>
          {busy ? "Saving…" : `Continue with ${selected.size} selected`}
        </Button>
      </div>
    </div>
  );
}
