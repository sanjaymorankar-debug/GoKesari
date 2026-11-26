"use client";

/**
 * Stock and price: a table on wide screens, one card per product on phones.
 * Step 3 and My products share it. All rows are kept in the browser and shown
 * a page at a time; saving sends only what is needed, in batches.
 *
 * UX rules (docs/ux-mobile-2026-11/README.md, owner brief 25-Nov-2026):
 *  - inputs are white with a 1.5 px slate-500 border (4.7:1 against white,
 *    WCAG 1.4.11 asks 3:1), 16 px text (no iOS zoom), a strong focus ring,
 *    a ₹ prefix on prices and an amber fill when a required box is empty;
 *  - nothing is selected at first; the bulk tools show once rows are picked;
 *  - pausing sits behind a ⋮ menu and asks first;
 *  - edited rows are marked, a sticky bar says "Save changes (n)" with
 *    Discard, a toast confirms the save, and leaving with unsaved edits asks;
 *  - Enter (the phone keypad's "Next") moves to the next box, row by row.
 */
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { postJson } from "@/components/save-changes-bar";
import { Alert, Badge, Button } from "@/components/ui";
import { LISTING_STATUS_LABEL, type ListingStatus } from "@/lib/listing-status";
import { stockQuantityProblem } from "@/lib/stock-quantity";
import type { ListingRow, ListingSaveResult } from "@/server/services/shop-product-setup";
import { ResultSummary } from "./result-summary";

const PAGE = 25;
const SAVE_BATCH = 100;

interface Draft {
  price: string;
  stock: string;
  mrp: string;
}

type Sort = "list" | "name" | "needs" | "price" | "stock";

const toRupees = (paise: number | null) => (paise == null ? "" : String(paise / 100));
const toPaise = (v: string) => Math.round(Number(v) * 100);
const BADGE: Record<ListingStatus, "success" | "warning" | "danger" | "neutral"> = {
  LIVE: "success",
  NEEDS_STOCK: "warning",
  NEEDS_PRICE: "warning",
  OUT_OF_STOCK: "danger",
  PAUSED: "neutral",
};

/** A packaged product whose pack size was never filled shows as "1 g" / "1 ml": flag it. */
export function packSizeLooksWrong(row: Pick<ListingRow, "kind" | "packSize">): boolean {
  return row.kind === "PACKAGED" && /^1 (g|ml|gm|kg|l)$/i.test(row.packSize.trim());
}

/** "150 g pack" for packaged goods, "Sold per kg" for loose ones. */
export function packLine(row: Pick<ListingRow, "kind" | "packSize" | "unit">): string {
  if (row.kind === "LOOSE") return `Sold per ${row.unit}`;
  const piece = /^1 (piece|pc|pcs|nos|no|unit|each)s?$/i.exec(row.packSize.trim());
  return piece ? "Per piece" : `${row.packSize} pack`;
}

function sameDraft(a: Draft, b: Draft): boolean {
  return a.price.trim() === b.price.trim() && a.stock.trim() === b.stock.trim() && a.mrp.trim() === b.mrp.trim();
}

function problems(row: ListingRow, d: Draft): { price?: string; stock?: string; mrp?: string } {
  const out: { price?: string; stock?: string; mrp?: string } = {};
  if (d.stock.trim() !== "") out.stock = stockQuantityProblem(Number(d.stock), row.kind, "Stock") ?? undefined;
  if (d.mrp.trim() !== "" && !(Number(d.mrp) > 0)) out.mrp = "MRP must be more than 0.";
  else if (d.mrp.trim() === "" && row.kind === "PACKAGED" && d.price.trim() !== "") out.mrp = "Enter the MRP to go live.";
  if (d.price.trim() !== "") {
    const price = Number(d.price);
    const mrp = d.mrp.trim() !== "" ? Number(d.mrp) : null;
    if (!(price > 0)) out.price = "Price must be more than 0.";
    else if (mrp != null && price > mrp) out.price = "Price cannot be more than the MRP.";
  }
  return out;
}

export function StockEditor({
  shopId,
  rows,
  mode,
  needsHref,
  productsHref,
}: {
  shopId: string;
  rows: ListingRow[];
  mode: "setup" | "manage";
  needsHref: string;
  productsHref: string;
}) {
  const router = useRouter();
  const initial = useMemo(() => {
    const out = new Map<string, Draft>();
    for (const r of rows) {
      out.set(r.shopProductId, {
        price: toRupees(r.pricePaise),
        stock: r.stock == null ? "" : String(r.stock),
        mrp: toRupees(r.shopMrpPaise ?? (r.kind === "PACKAGED" ? r.masterMrpPaise : null)),
      });
    }
    return out;
  }, [rows]);
  const [drafts, setDrafts] = useState(initial);
  // Nothing is picked at first: a bulk change only ever touches rows the owner chose.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("list");
  const [bulkStock, setBulkStock] = useState("");
  const [bulkDiscount, setBulkDiscount] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
  const [result, setResult] = useState<ListingSaveResult | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmPause, setConfirmPause] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const draftOf = (id: string) => drafts.get(id) ?? { price: "", stock: "", mrp: "" };
  const update = (id: string, patch: Partial<Draft>) =>
    setDrafts((current) => new Map(current).set(id, { ...(current.get(id) ?? { price: "", stock: "", mrp: "" }), ...patch }));

  const isDirty = (id: string) => !sameDraft(draftOf(id), initial.get(id) ?? { price: "", stock: "", mrp: "" });
  const dirtyIds = rows.filter((r) => isDirty(r.shopProductId)).map((r) => r.shopProductId);
  const dirtyCount = dirtyIds.length;
  // In setup every row is saved; in My products only the edited ones, so old gaps never block a save.
  const counts = (r: ListingRow) => mode === "setup" || isDirty(r.shopProductId);
  const hasProblems = rows.some((r) => counts(r) && Object.values(problems(r, draftOf(r.shopProductId))).some(Boolean));

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? rows.filter((r) => [r.name, r.brandName ?? "", r.code, r.categoryName].join(" ").toLowerCase().includes(q))
      : rows.slice();
    const rank: Record<ListingStatus, number> = { NEEDS_PRICE: 0, NEEDS_STOCK: 1, OUT_OF_STOCK: 2, PAUSED: 3, LIVE: 4 };
    if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "needs") list.sort((a, b) => rank[a.status] - rank[b.status]);
    if (sort === "price") list.sort((a, b) => (a.pricePaise ?? -1) - (b.pricePaise ?? -1));
    if (sort === "stock") list.sort((a, b) => (a.stock ?? -1) - (b.stock ?? -1));
    return list;
  }, [rows, query, sort]);
  const pages = Math.max(1, Math.ceil(visible.length / PAGE));
  const safePage = Math.min(page, pages - 1);
  const pageRows = visible.slice(safePage * PAGE, (safePage + 1) * PAGE);

  // Leaving with unsaved edits asks first: a reload or closing the tab, and any link on the page.
  useEffect(() => {
    if (dirtyCount === 0 || busy) return;
    const message = `You have ${dirtyCount} unsaved ${dirtyCount === 1 ? "change" : "changes"}. Leave without saving?`;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.search === window.location.search) return;
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirtyCount, busy]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  function applyBulkStock() {
    if (bulkStock.trim() === "") return;
    setDrafts((current) => {
      const next = new Map(current);
      for (const r of rows) {
        if (selected.has(r.shopProductId)) next.set(r.shopProductId, { ...next.get(r.shopProductId)!, stock: bulkStock.trim() });
      }
      return next;
    });
  }

  function applyDiscount() {
    const pct = Number(bulkDiscount);
    if (!(pct > 0 && pct < 100)) {
      setError("Enter a discount from 1 to 99 percent.");
      return;
    }
    setError(null);
    setDrafts((current) => {
      const next = new Map(current);
      for (const r of rows) {
        const d = next.get(r.shopProductId)!;
        if (selected.has(r.shopProductId) && d.mrp.trim() !== "") {
          next.set(r.shopProductId, { ...d, price: String(Math.round(Number(d.mrp) * (100 - pct)) / 100) });
        }
      }
      return next;
    });
  }

  function step(row: ListingRow, by: number) {
    const current = Number(draftOf(row.shopProductId).stock || 0);
    update(row.shopProductId, { stock: String(Math.max(0, current + by)) });
  }

  function discard() {
    setDrafts(new Map(initial));
    setError(null);
    setRowErrors(new Map());
  }

  /** Enter / the keypad's "Next" moves to the next box: across the row, then the next row (spreadsheet-style). */
  function nextCell(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const cells = Array.from(listRef.current?.querySelectorAll<HTMLInputElement>("input[data-gk-cell]") ?? []);
    const at = cells.indexOf(e.currentTarget);
    const next = cells[at + 1];
    if (next) {
      next.focus();
      next.select();
    } else e.currentTarget.blur();
  }

  async function setPaused(row: ListingRow, paused: boolean) {
    setBusy(true);
    setError(null);
    setMenuFor(null);
    setConfirmPause(null);
    try {
      await postJson(`/api/shops/${shopId}/product-setup/listings`, "PATCH", { shopProductId: row.shopProductId, paused });
      setToast(paused ? `${row.name} is paused. Customers no longer see it.` : `${row.name} is on sale again.`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function save(action: "live" | "skip") {
    setBusy(true);
    setError(null);
    setRowErrors(new Map());
    const payload = rows.flatMap((r) => {
      const d = draftOf(r.shopProductId);
      const before = initial.get(r.shopProductId)!;
      const stockChanged = d.stock.trim() !== "" && d.stock.trim() !== before.stock;
      const priceChanged = d.price.trim() !== "" && d.price.trim() !== before.price;
      const mrpChanged = d.mrp.trim() !== "" && d.mrp.trim() !== before.mrp;
      if (mode === "manage" && !stockChanged && !priceChanged && !mrpChanged) return [];
      return [
        {
          shopProductId: r.shopProductId,
          // In setup the pre-filled price counts too: it is what goes live.
          pricePaise: mode === "setup" ? (d.price.trim() !== "" ? toPaise(d.price) : null) : priceChanged ? toPaise(d.price) : null,
          stock: mode === "setup" ? (d.stock.trim() !== "" ? Number(d.stock) : null) : stockChanged ? Number(d.stock) : null,
          shopMrpPaise: mrpChanged ? toPaise(d.mrp) : null,
          ...(mode === "manage" && stockChanged && r.stock != null ? { expectedOnlineStock: r.onlineStock } : {}),
        },
      ];
    });
    const total: ListingSaveResult = { live: 0, needsStockOrPrice: 0, outOfStock: 0, paused: 0, errors: [] };
    try {
      for (let i = 0; i < payload.length; i += SAVE_BATCH) {
        setProgress(`Saving ${Math.min(i + SAVE_BATCH, payload.length)} of ${payload.length}…`);
        const part = await postJson<ListingSaveResult>(`/api/shops/${shopId}/product-setup/listings`, "POST", {
          action,
          rows: payload.slice(i, i + SAVE_BATCH),
        });
        total.live += part.live;
        total.needsStockOrPrice += part.needsStockOrPrice;
        total.outOfStock += part.outOfStock;
        total.paused += part.paused;
        total.errors.push(...part.errors);
      }
      if (total.errors.length) {
        setRowErrors(new Map(total.errors.map((e) => [e.shopProductId, e.message])));
        setError(`${total.errors.length} ${total.errors.length === 1 ? "product was" : "products were"} not saved. Look for the messages in red.`);
      }
      if (mode === "setup") setResult(total);
      else if (total.errors.length === 0) {
        const n = payload.length;
        setToast(`Saved ${n} ${n === 1 ? "product" : "products"}. ${total.live} live now.`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  if (result && !error) {
    return <ResultSummary live={result.live} needs={result.needsStockOrPrice} outOfStock={result.outOfStock} needsHref={needsHref} productsHref={productsHref} />;
  }

  const allOnPage = pageRows.length > 0 && pageRows.every((r) => selected.has(r.shopProductId));
  const toggleAll = (ids: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const field = (row: ListingRow, key: keyof Draft, label: string, opts: { message?: string; rupee?: boolean; placeholder: string; required?: boolean; visibleLabel?: string }) => {
    const value = draftOf(row.shopProductId)[key];
    const empty = value.trim() === "";
    return (
      <label className="block min-w-0 text-sm font-medium text-ink-700">
        <span className="mb-1 block lg:sr-only">{opts.visibleLabel ?? label}</span>
        <span className="relative block">
          {opts.rupee ? (
            <span aria-hidden className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-base font-semibold text-ink-600">
              ₹
            </span>
          ) : null}
          <input
            data-gk-cell
            inputMode="decimal"
            enterKeyHint="next"
            autoComplete="off"
            className={clsx(
              "h-12 w-full rounded-lg border-[1.5px] bg-white text-base text-ink-900 tabular-nums placeholder:text-amber-800/80",
              "focus:border-kesari-700 focus:outline-none focus:ring-4 focus:ring-kesari-300/70",
              opts.rupee ? "pl-7 pr-2" : "px-3",
              opts.message ? "border-red-600 bg-red-50" : empty && opts.required ? "border-amber-600 bg-amber-50" : "border-slate-500",
            )}
            aria-label={`${label} for ${row.name}`}
            aria-invalid={Boolean(opts.message)}
            aria-describedby={opts.message ? `${row.shopProductId}-${key}-err` : undefined}
            placeholder={opts.placeholder}
            value={value}
            onChange={(e) => update(row.shopProductId, { [key]: e.target.value })}
            onKeyDown={nextCell}
            onFocus={(e) => e.currentTarget.select()}
          />
        </span>
        {opts.message ? (
          <span id={`${row.shopProductId}-${key}-err`} className="mt-1 block text-sm font-medium text-red-700">
            {opts.message}
          </span>
        ) : null}
      </label>
    );
  };

  return (
    <div className="space-y-4" data-testid="stock-editor">
      {/* Find and sort */}
      <div className="flex gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search products</span>
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="Search name, brand or code"
            className="h-12 w-full rounded-lg border-[1.5px] border-slate-500 bg-white px-3 text-base text-ink-900 placeholder:text-ink-500 focus:border-kesari-700 focus:outline-none focus:ring-4 focus:ring-kesari-300/70"
            data-testid="stock-search"
          />
        </label>
        <label className="flex shrink-0 items-center gap-2 text-sm font-medium text-ink-700">
          <span className="sr-only sm:not-sr-only">Sort</span>
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as Sort);
              setPage(0);
            }}
            aria-label="Sort products"
            className="h-12 w-[7.5rem] rounded-lg border-[1.5px] border-slate-500 bg-white px-2 text-base sm:w-auto text-ink-900 focus:border-kesari-700 focus:outline-none focus:ring-4 focus:ring-kesari-300/70"
            data-testid="stock-sort"
          >
            <option value="list">Category</option>
            <option value="needs">Needs action</option>
            <option value="name">Name A–Z</option>
            <option value="price">Price, low first</option>
            <option value="stock">Stock, low first</option>
          </select>
        </label>
      </div>

      {/* Selection: none at first; the bulk tools appear once rows are picked. */}
      <div className="flex flex-wrap items-center gap-x-4">
        <label className="flex min-h-11 items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" className="size-5 accent-kesari-600" checked={allOnPage} onChange={() => toggleAll(pageRows.map((r) => r.shopProductId), !allOnPage)} />
          Select this page ({selected.size} of {rows.length} selected)
        </label>
        {selected.size > 0 ? (
          <button type="button" className="min-h-11 text-sm font-semibold text-kesari-800 underline" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        ) : visible.length > pageRows.length ? (
          <button type="button" className="min-h-11 text-sm font-semibold text-kesari-800 underline" onClick={() => toggleAll(visible.map((r) => r.shopProductId), true)}>
            Select all {visible.length}
          </button>
        ) : null}
      </div>

      {selected.size > 0 ? (
        <div className="grid gap-3 rounded-2xl border-[1.5px] border-kesari-300 bg-kesari-50 p-3 sm:grid-cols-2" data-testid="bulk-tools">
          <p className="text-sm font-semibold text-ink-900 sm:col-span-2">
            Change {selected.size} selected {selected.size === 1 ? "product" : "products"} at once
          </p>
          <div className="flex items-end gap-2">
            <label className="flex-1 text-sm font-medium text-ink-700">
              Same stock for selected
              <input
                inputMode="decimal"
                className="mt-1 h-12 w-full rounded-lg border-[1.5px] border-slate-500 bg-white px-3 text-base focus:border-kesari-700 focus:outline-none focus:ring-4 focus:ring-kesari-300/70"
                value={bulkStock}
                onChange={(e) => setBulkStock(e.target.value)}
              />
            </label>
            <Button variant="secondary" className="min-h-12" onClick={applyBulkStock}>
              Apply
            </Button>
          </div>
          <div className="flex items-end gap-2">
            <label className="flex-1 text-sm font-medium text-ink-700">
              Discount off MRP (%)
              <input
                inputMode="decimal"
                className="mt-1 h-12 w-full rounded-lg border-[1.5px] border-slate-500 bg-white px-3 text-base focus:border-kesari-700 focus:outline-none focus:ring-4 focus:ring-kesari-300/70"
                value={bulkDiscount}
                onChange={(e) => setBulkDiscount(e.target.value)}
              />
            </label>
            <Button variant="secondary" className="min-h-12" onClick={applyDiscount}>
              Apply
            </Button>
          </div>
        </div>
      ) : null}

      {pageRows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-400 bg-white p-6 text-center text-ink-700" data-testid="stock-empty">
          No products match “{query}”. Try another name or clear the search.
        </p>
      ) : null}

      <div
        ref={listRef}
        className="space-y-3 lg:space-y-0 lg:divide-y lg:divide-slate-200 lg:rounded-2xl lg:border lg:border-slate-300 lg:bg-white"
        data-testid="stock-rows"
      >
        <div className="hidden gap-3 px-3 py-2 text-xs font-semibold uppercase text-ink-600 lg:grid lg:grid-cols-[2rem_minmax(0,1fr)_7.5rem_7.5rem_13.5rem_2.75rem]">
          <span />
          <span>Product</span>
          <span>MRP (₹)</span>
          <span>Selling price (₹)</span>
          <span>Stock</span>
          <span className="sr-only">More</span>
        </div>
        {pageRows.map((r) => {
          const d = draftOf(r.shopProductId);
          const edited = isDirty(r.shopProductId);
          const p = counts(r) ? problems(r, d) : {};
          const stockLabel = r.kind === "LOOSE" ? `Stock (${r.unit})` : "Stock (packs)";
          return (
            <div
              key={r.shopProductId}
              className={clsx(
                "relative grid grid-cols-2 gap-3 rounded-2xl border bg-white p-3 lg:grid-cols-[2rem_minmax(0,1fr)_7.5rem_7.5rem_13.5rem_2.75rem] lg:items-start lg:rounded-none lg:border-0 lg:border-l-4",
                edited ? "border-l-4 border-kesari-600 border-y-slate-300 border-r-slate-300 lg:border-l-kesari-600 lg:bg-kesari-50/40" : "border-slate-300 lg:border-l-transparent",
              )}
              data-testid="stock-row"
              data-edited={edited ? "true" : undefined}
            >
              <div className="col-span-2 flex items-start gap-3 lg:contents">
                <input
                  type="checkbox"
                  className="mt-1 size-5 shrink-0 accent-kesari-600"
                  aria-label={`Select ${r.name}`}
                  checked={selected.has(r.shopProductId)}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (!next.delete(r.shopProductId)) next.add(r.shopProductId);
                      return next;
                    })
                  }
                />
                <div className="min-w-0 flex-1 pr-10 lg:pr-0">
                  <p className="break-words font-semibold leading-snug text-ink-900">{r.name}</p>
                  <p className="mt-0.5 text-sm text-ink-600">
                    <span className="font-medium text-ink-800">{packLine(r)}</span>
                    {[r.brandName, r.code].filter(Boolean).length ? ` · ${[r.brandName, r.code].filter(Boolean).join(" · ")}` : ""}
                  </p>
                  {packSizeLooksWrong(r) ? (
                    <p className="mt-0.5 text-xs font-medium text-amber-800" data-testid="pack-size-warning">
                      Pack size looks wrong — tell support the real size.
                    </p>
                  ) : null}
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone={BADGE[r.status]}>{LISTING_STATUS_LABEL[r.status]}</Badge>
                    {edited ? (
                      <span className="rounded-full bg-kesari-100 px-2 py-0.5 text-xs font-bold text-kesari-800" data-testid="row-edited">
                        Edited
                      </span>
                    ) : null}
                  </div>
                  {rowErrors.get(r.shopProductId) ? <p className="mt-1 text-sm font-medium text-red-700">{rowErrors.get(r.shopProductId)}</p> : null}
                </div>
              </div>
              {field(r, "mrp", "MRP (₹)", { message: p.mrp, rupee: true, placeholder: "Enter MRP", required: r.kind === "PACKAGED", visibleLabel: "MRP" })}
              {field(r, "price", "Selling price (₹)", { message: p.price, rupee: true, placeholder: "Enter price", required: true, visibleLabel: "Selling price" })}
              <div className="col-span-2 lg:col-span-1">
                <div className="flex items-end gap-1.5">
                  <button
                    type="button"
                    className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border-[1.5px] border-slate-500 bg-white text-xl font-bold text-ink-900 hover:bg-slate-100 focus:outline-none focus:ring-4 focus:ring-kesari-300/70"
                    aria-label={`One less ${r.name}`}
                    onClick={() => step(r, -1)}
                  >
                    −
                  </button>
                  <div className="min-w-0 flex-1">
                    {field(r, "stock", "Stock", { message: p.stock, placeholder: "Enter stock", required: r.status === "NEEDS_STOCK", visibleLabel: stockLabel })}
                  </div>
                  <button
                    type="button"
                    className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border-[1.5px] border-slate-500 bg-white text-xl font-bold text-ink-900 hover:bg-slate-100 focus:outline-none focus:ring-4 focus:ring-kesari-300/70"
                    aria-label={`One more ${r.name}`}
                    onClick={() => step(r, 1)}
                  >
                    +
                  </button>
                </div>
              </div>
              {mode === "manage" ? (
                <RowMenu
                  row={r}
                  open={menuFor === r.shopProductId}
                  confirming={confirmPause === r.shopProductId}
                  busy={busy}
                  onToggle={() => {
                    setMenuFor((v) => (v === r.shopProductId ? null : r.shopProductId));
                    setConfirmPause(null);
                  }}
                  onAskPause={() => setConfirmPause(r.shopProductId)}
                  onCancel={() => {
                    setConfirmPause(null);
                    setMenuFor(null);
                  }}
                  onSet={(paused) => setPaused(r, paused)}
                  className="absolute right-1.5 top-1.5 lg:static"
                />
              ) : (
                <span className="hidden lg:block" />
              )}
            </div>
          );
        })}
      </div>

      {visible.length > PAGE ? (
        <div className="flex items-center justify-between text-sm">
          <Button size="sm" variant="secondary" className="min-h-11" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
            Previous
          </Button>
          <span className="text-ink-600">
            Page {safePage + 1} of {pages}
          </span>
          <Button size="sm" variant="secondary" className="min-h-11" disabled={safePage + 1 >= pages} onClick={() => setPage(safePage + 1)}>
            Next
          </Button>
        </div>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {progress ? (
        <p className="text-sm text-ink-600" role="status">
          {progress}
        </p>
      ) : null}

      <div
        className="sticky bottom-[var(--gk-bottom-nav,0px)] z-20 -mx-4 flex flex-wrap items-center gap-2 border-t border-slate-300 bg-white p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_12px_rgba(0,0,0,0.06)] sm:mx-0 sm:rounded-xl sm:border lg:pb-3"
        data-testid="stock-save-bar"
      >
        {mode === "setup" ? (
          <>
            <Button className="min-h-12 flex-1" disabled={busy || hasProblems} onClick={() => save("live")}>
              Save and go live
            </Button>
            <Button className="min-h-12 flex-1" variant="secondary" disabled={busy || hasProblems} onClick={() => save("skip")}>
              Skip, update stock later
            </Button>
          </>
        ) : (
          <>
            <p className="min-w-[7.5rem] flex-1 text-sm text-ink-700" aria-live="polite">
              {dirtyCount > 0 ? (
                <>
                  <span className="font-bold text-kesari-800">{dirtyCount}</span> unsaved {dirtyCount === 1 ? "change" : "changes"}
                  {hasProblems ? <span className="text-red-700"> · fix the boxes in red</span> : null}
                </>
              ) : (
                "No unsaved changes"
              )}
            </p>
            {dirtyCount > 0 ? (
              <Button variant="secondary" className="min-h-12" disabled={busy} onClick={discard}>
                Discard
              </Button>
            ) : null}
            <Button className="min-h-12 shrink-0 px-5 sm:px-6" disabled={busy || hasProblems || dirtyCount === 0} onClick={() => save("live")}>
              Save changes{dirtyCount > 0 ? ` (${dirtyCount})` : ""}
            </Button>
          </>
        )}
      </div>

      {toast ? (
        <div
          role="status"
          className="fixed inset-x-3 bottom-[calc(var(--gk-bottom-nav,0px)+5.5rem)] z-50 mx-auto max-w-md rounded-xl bg-ink-900 px-4 py-3 text-center text-sm font-semibold text-white shadow-xl"
          data-testid="stock-toast"
        >
          ✓ {toast}
        </div>
      ) : null}
    </div>
  );
}

/** ⋮ menu per row: Pause selling asks first; Resume is one tap. */
function RowMenu({
  row,
  open,
  confirming,
  busy,
  onToggle,
  onAskPause,
  onCancel,
  onSet,
  className,
}: {
  row: ListingRow;
  open: boolean;
  confirming: boolean;
  busy: boolean;
  onToggle: () => void;
  onAskPause: () => void;
  onCancel: () => void;
  onSet: (paused: boolean) => void;
  className?: string;
}) {
  return (
    <div className={clsx("relative shrink-0", className)}>
      <button
        type="button"
        className="grid h-11 w-11 place-items-center rounded-lg text-xl font-bold text-ink-700 hover:bg-slate-100 focus:outline-none focus:ring-4 focus:ring-kesari-300/70"
        aria-label={`More actions for ${row.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        ⋮
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-64 rounded-xl border border-slate-300 bg-white p-2 text-left shadow-xl">
          {row.ownerPaused ? (
            <button type="button" role="menuitem" disabled={busy} className="flex min-h-11 w-full items-center rounded-lg px-3 text-sm font-semibold text-leaf-700 hover:bg-slate-100" onClick={() => onSet(false)}>
              Resume selling
            </button>
          ) : confirming ? (
            <div className="space-y-2 p-1">
              <p className="text-sm text-ink-800">Pause selling {row.name}? Customers will not see it until you resume.</p>
              <div className="flex gap-2">
                <button type="button" disabled={busy} className="min-h-11 flex-1 rounded-lg bg-red-700 px-3 text-sm font-bold text-white hover:bg-red-800" onClick={() => onSet(true)}>
                  Pause selling
                </button>
                <button type="button" className="min-h-11 flex-1 rounded-lg border border-slate-400 px-3 text-sm font-semibold text-ink-800 hover:bg-slate-100" onClick={onCancel}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" role="menuitem" disabled={busy} className="flex min-h-11 w-full items-center rounded-lg px-3 text-sm font-semibold text-red-700 hover:bg-red-50" onClick={onAskPause}>
              Pause selling…
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
