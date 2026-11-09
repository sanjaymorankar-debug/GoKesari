"use client";

/**
 * Stock and price: a table on wide screens, cards on phones. Step 3 and My
 * products share it. All rows are kept in the browser and shown a page at a
 * time; saving sends only what is needed, in batches.
 */
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { postJson } from "@/components/save-changes-bar";
import { Alert, Badge, Button, inputClass } from "@/components/ui";
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

const toRupees = (paise: number | null) => (paise == null ? "" : String(paise / 100));
const toPaise = (v: string) => Math.round(Number(v) * 100);
const BADGE: Record<ListingStatus, "success" | "warning" | "danger" | "neutral"> = {
  LIVE: "success",
  NEEDS_STOCK: "warning",
  NEEDS_PRICE: "warning",
  OUT_OF_STOCK: "danger",
  PAUSED: "neutral",
};

function problems(row: ListingRow, d: Draft): { price?: string; stock?: string; mrp?: string } {
  const out: { price?: string; stock?: string; mrp?: string } = {};
  if (d.stock.trim() !== "") out.stock = stockQuantityProblem(Number(d.stock), row.kind, "Stock") ?? undefined;
  if (d.mrp.trim() !== "" && !(Number(d.mrp) > 0)) out.mrp = "MRP must be more than 0.";
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
  const [selected, setSelected] = useState(() => new Set(rows.map((r) => r.shopProductId)));
  const [page, setPage] = useState(0);
  const [bulkStock, setBulkStock] = useState("");
  const [bulkDiscount, setBulkDiscount] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
  const [result, setResult] = useState<ListingSaveResult | null>(null);

  const pageRows = rows.slice(page * PAGE, (page + 1) * PAGE);
  const draftOf = (id: string) => drafts.get(id) ?? { price: "", stock: "", mrp: "" };
  const update = (id: string, patch: Partial<Draft>) =>
    setDrafts((current) => new Map(current).set(id, { ...(current.get(id) ?? { price: "", stock: "", mrp: "" }), ...patch }));

  const hasProblems = rows.some((r) => Object.values(problems(r, draftOf(r.shopProductId))).some(Boolean));

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

  async function setPaused(row: ListingRow, paused: boolean) {
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/shops/${shopId}/product-setup/listings`, "PATCH", { shopProductId: row.shopProductId, paused });
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
      if (mode === "setup" || total.errors.length === 0) setResult(total);
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

  const input = (row: ListingRow, field: keyof Draft, label: string, message?: string) => (
    <label className="block text-xs text-ink-500">
      <span className="lg:sr-only">{label}</span>
      <input
        inputMode="decimal"
        className={clsx(inputClass, "min-h-11", message && "border-red-500")}
        aria-label={`${label} for ${row.name}`}
        aria-invalid={Boolean(message)}
        value={draftOf(row.shopProductId)[field]}
        onChange={(e) => update(row.shopProductId, { [field]: e.target.value })}
      />
      {message ? <span className="mt-0.5 block text-xs text-red-700">{message}</span> : null}
    </label>
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-2xl border border-cream-200 bg-white p-3 sm:grid-cols-2">
        <div className="flex items-end gap-2">
          <label className="flex-1 text-sm text-ink-700">
            Same stock for selected
            <input inputMode="decimal" className={inputClass} value={bulkStock} onChange={(e) => setBulkStock(e.target.value)} />
          </label>
          <Button variant="secondary" onClick={applyBulkStock}>Apply</Button>
        </div>
        <div className="flex items-end gap-2">
          <label className="flex-1 text-sm text-ink-700">
            Discount off MRP (%)
            <input inputMode="decimal" className={inputClass} value={bulkDiscount} onChange={(e) => setBulkDiscount(e.target.value)} />
          </label>
          <Button variant="secondary" onClick={applyDiscount}>Apply</Button>
        </div>
      </div>

      <label className="flex min-h-11 items-center gap-2 text-sm text-ink-700">
        <input
          type="checkbox"
          className="size-5 accent-kesari-600"
          checked={allOnPage}
          onChange={() =>
            setSelected((current) => {
              const next = new Set(current);
              for (const r of pageRows) {
                if (allOnPage) next.delete(r.shopProductId);
                else next.add(r.shopProductId);
              }
              return next;
            })
          }
        />
        Select this page ({selected.size} of {rows.length} selected)
      </label>

      <div className="space-y-3 lg:space-y-0 lg:divide-y lg:divide-cream-100 lg:rounded-2xl lg:border lg:border-cream-200 lg:bg-white" data-testid="stock-rows">
        <div className="hidden gap-3 px-3 py-2 text-xs uppercase text-ink-500 lg:grid lg:grid-cols-[2rem_minmax(0,1fr)_6rem_6rem_13rem_3.5rem]">
          <span />
          <span>Product</span>
          <span>MRP (₹)</span>
          <span>Selling price (₹)</span>
          <span>Stock</span>
          <span>Unit</span>
        </div>
        {pageRows.map((r) => {
          const p = problems(r, draftOf(r.shopProductId));
          return (
            <div
              key={r.shopProductId}
              className="grid grid-cols-2 gap-3 rounded-2xl border border-cream-200 bg-white p-3 lg:grid-cols-[2rem_minmax(0,1fr)_6rem_6rem_13rem_3.5rem] lg:items-start lg:rounded-none lg:border-0"
              data-testid="stock-row"
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
                <div className="min-w-0">
                  <p className="font-medium text-ink-900">{r.name}</p>
                  <p className="text-xs text-ink-500">{[r.brandName, r.packSize, r.code].filter(Boolean).join(" · ")}</p>
                  <Badge tone={BADGE[r.status]}>{LISTING_STATUS_LABEL[r.status]}</Badge>
                  {mode === "manage" ? (
                    <button type="button" disabled={busy} className="ml-2 min-h-11 text-xs font-medium text-kesari-700 underline" onClick={() => setPaused(r, !r.ownerPaused)}>
                      {r.ownerPaused ? "Resume selling" : "Pause selling"}
                    </button>
                  ) : null}
                  {rowErrors.get(r.shopProductId) ? <p className="mt-1 text-xs text-red-700">{rowErrors.get(r.shopProductId)}</p> : null}
                </div>
              </div>
              {input(r, "mrp", "MRP (₹)", p.mrp)}
              {input(r, "price", "Selling price (₹)", p.price)}
              <div className="col-span-2 flex items-start gap-1 lg:col-span-1">
                <Button variant="secondary" aria-label={`One less ${r.name}`} onClick={() => step(r, -1)}>
                  −
                </Button>
                <div className="min-w-0 flex-1">{input(r, "stock", "Stock", p.stock)}</div>
                <Button variant="secondary" aria-label={`One more ${r.name}`} onClick={() => step(r, 1)}>
                  +
                </Button>
              </div>
              <p className="hidden pt-2 text-sm text-ink-700 lg:block">{r.unit}</p>
            </div>
          );
        })}
      </div>

      {rows.length > PAGE ? (
        <div className="flex items-center justify-between text-sm">
          <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-ink-500">
            Page {page + 1} of {Math.ceil(rows.length / PAGE)}
          </span>
          <Button size="sm" variant="secondary" disabled={(page + 1) * PAGE >= rows.length} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {progress ? <p className="text-sm text-ink-500" role="status">{progress}</p> : null}

      <div className="sticky bottom-0 z-20 -mx-4 flex flex-wrap gap-2 border-t border-cream-200 bg-white p-3 sm:mx-0 sm:rounded-xl sm:border">
        {mode === "setup" ? (
          <>
            <Button className="flex-1" disabled={busy || hasProblems} onClick={() => save("live")}>
              Save and go live
            </Button>
            <Button className="flex-1" variant="secondary" disabled={busy || hasProblems} onClick={() => save("skip")}>
              Skip, update stock later
            </Button>
          </>
        ) : (
          <Button className="flex-1" disabled={busy || hasProblems} onClick={() => save("live")}>
            Save changes
          </Button>
        )}
      </div>
    </div>
  );
}
