"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, Money, inputClass } from "@/components/ui";
import { paiseToRupees, rupeesToPaise } from "@/lib/money";

export interface InventoryRowView {
  shopProductId: string;
  productCode: string;
  productName: string;
  unit: string;
  /** The shop's own price; null until the owner sets one. */
  onlinePricePaise: number | null;
  available: number;
  reserved: number;
  onHand: number;
  status: "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";
  reorderNeeded: boolean;
  thresholds: {
    lowStock: number;
    reorderLevel: number | null;
    reorderQuantity: number | null;
    source: { lowStock: string; reorderLevel: string; reorderQuantity: string };
    alertsDisabled: boolean;
  };
  own: { lowStockThreshold: number; reorderLevel: number | null; reorderQuantity: number | null; stockAlertsDisabled: boolean };
  openAlerts: string[];
}

export interface InventoryView {
  dashboard: { totalProducts: number; inStock: number; lowStock: number; outOfStock: number; reorderRequired: number; inventoryValuePaise: number };
  rows: InventoryRowView[];
  alerts: { id: string; shopProductId: string; alertType: string; stockAtAlert: number }[];
  shopDefaults: { lowStockThreshold: number; reorderLevel: number | null; reorderQuantity: number | null };
}

const STATUS_TONE = { IN_STOCK: "success", LOW_STOCK: "warning", OUT_OF_STOCK: "danger" } as const;
const STATUS_LABEL = { IN_STOCK: "In stock", LOW_STOCK: "Low", OUT_OF_STOCK: "Out of stock" } as const;
const SOURCE_LABEL: Record<string, string> = { LISTING: "this product", PRODUCT: "product default", SHOP: "shop default", NONE: "not set" };

const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

/** Stock levels, thresholds at shop / product / listing level, and open alerts for a shop. */
export function ShopInventoryManager({ shopId, view }: { shopId: string; view: InventoryView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defaults, setDefaults] = useState({
    low: String(view.shopDefaults.lowStockThreshold),
    level: view.shopDefaults.reorderLevel != null ? String(view.shopDefaults.reorderLevel) : "",
    qty: view.shopDefaults.reorderQuantity != null ? String(view.shopDefaults.reorderQuantity) : "",
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ low: "", level: "", qty: "", off: false });
  // Prices typed in the table, by listing, until "Save prices" sends them.
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({});
  const [priceErrors, setPriceErrors] = useState<Record<string, string>>({});
  const [priceMessage, setPriceMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [needsPriceOnly, setNeedsPriceOnly] = useState(false);

  const needsPriceCount = view.rows.filter((r) => r.onlinePricePaise == null).length;
  const shownRows = needsPriceOnly ? view.rows.filter((r) => r.onlinePricePaise == null) : view.rows;

  async function savePrices() {
    setPriceMessage(null);
    const errors: Record<string, string> = {};
    const prices: { shopProductId: string; pricePaise: number }[] = [];
    for (const [shopProductId, raw] of Object.entries(priceEdits)) {
      const row = view.rows.find((r) => r.shopProductId === shopProductId);
      if (!row) continue;
      const value = raw.trim();
      // Clearing a box that had a price is not a change: a price cannot be removed here.
      if (value === "" && row.onlinePricePaise != null) continue;
      const rupees = Number(value);
      if (value === "" || !Number.isFinite(rupees) || rupees <= 0) {
        errors[shopProductId] = "Enter a price greater than 0.";
        continue;
      }
      const pricePaise = rupeesToPaise(rupees);
      if (pricePaise !== row.onlinePricePaise) prices.push({ shopProductId, pricePaise });
    }
    setPriceErrors(errors);
    if (Object.keys(errors).length > 0) {
      setPriceMessage({ tone: "danger", text: "Some prices are not valid — nothing was saved." });
      return;
    }
    if (prices.length === 0) {
      setPriceMessage({ tone: "danger", text: "No prices were changed." });
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/shops/${shopId}/prices`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prices }),
    }).catch(() => null);
    const payload = res ? await res.json().catch(() => null) : null;
    setBusy(false);
    if (!res?.ok) {
      setPriceMessage({ tone: "danger", text: payload?.error?.message ?? "Could not save the prices. Nothing was changed." });
      return;
    }
    setPriceEdits({});
    setPriceMessage({ tone: "success", text: `Saved ${prices.length} price${prices.length === 1 ? "" : "s"}.` });
    router.refresh();
  }

  async function call(url: string, body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(payload?.error?.message ?? "That did not work.");
      return false;
    }
    router.refresh();
    return true;
  }

  const d = view.dashboard;
  return (
    <div className="space-y-8">
      <div className="grid gap-3 sm:grid-cols-5" data-testid="inventory-summary">
        {[
          ["Products", d.totalProducts],
          ["In stock", d.inStock],
          ["Low", d.lowStock],
          ["Out of stock", d.outOfStock],
          ["Need reorder", d.reorderRequired],
        ].map(([label, n]) => (
          <Card key={label as string} className="p-4">
            <p className="text-xs uppercase tracking-wide text-ink-500">{label}</p>
            <p className="text-2xl font-semibold text-ink-900">{n}</p>
          </Card>
        ))}
      </div>
      <p className="-mt-4 text-sm text-ink-500">
        Stock value at your selling prices: <Money paise={d.inventoryValuePaise} />
      </p>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {view.alerts.length > 0 ? (
        <section>
          <h2 className="mb-2 text-lg font-semibold text-ink-900">Open alerts ({view.alerts.length})</h2>
          <Card className="divide-y divide-cream-100">
            {view.alerts.map((a) => {
              const row = view.rows.find((r) => r.shopProductId === a.shopProductId);
              return (
                <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <span>
                    <Badge tone={a.alertType === "OUT_OF_STOCK" ? "danger" : "warning"}>{a.alertType.replace(/_/g, " ").toLowerCase()}</Badge>{" "}
                    {row?.productName ?? "Product"} — {a.stockAtAlert} left when raised
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      await fetch(`/api/stock-alerts/${a.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "acknowledge" }),
                      });
                      setBusy(false);
                      router.refresh();
                    }}
                  >
                    Acknowledge
                  </Button>
                </div>
              );
            })}
          </Card>
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">Shop-wide defaults</h2>
        <Card className="space-y-3 p-4">
          <p className="text-sm text-ink-500">
            Used for any product that has no threshold of its own and no product-wide default. Leave a box empty for none.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Low-stock threshold">
              <input className={inputClass} inputMode="numeric" value={defaults.low} onChange={(e) => setDefaults({ ...defaults, low: e.target.value })} />
            </Field>
            <Field label="Reorder level">
              <input className={inputClass} inputMode="numeric" value={defaults.level} onChange={(e) => setDefaults({ ...defaults, level: e.target.value })} />
            </Field>
            <Field label="Reorder quantity">
              <input className={inputClass} inputMode="numeric" value={defaults.qty} onChange={(e) => setDefaults({ ...defaults, qty: e.target.value })} />
            </Field>
          </div>
          <Button
            disabled={busy}
            onClick={() =>
              call(`/api/shops/${shopId}/inventory`, {
                lowStockThreshold: num(defaults.low) ?? 0,
                reorderLevel: num(defaults.level),
                reorderQuantity: num(defaults.qty),
              })
            }
          >
            Save defaults
          </Button>
        </Card>
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-ink-900">Stock by product</h2>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setNeedsPriceOnly((v) => !v)}>
              {needsPriceOnly ? "Show all products" : `Needs a price (${needsPriceCount})`}
            </Button>
            <Button size="sm" disabled={busy} onClick={savePrices}>
              Save prices
            </Button>
          </div>
        </div>
        {priceMessage ? (
          <div className="mb-2">
            <Alert tone={priceMessage.tone}>{priceMessage.text}</Alert>
          </div>
        ) : null}
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="inventory-table">
            <thead className="bg-cream-100 text-xs uppercase text-ink-500">
              <tr>
                <th className="px-3 py-2">Product</th>
                <th className="px-3 py-2">Unit</th>
                <th className="px-3 py-2">Available</th>
                <th className="px-3 py-2">Price (₹)</th>
                <th className="px-3 py-2">Reserved</th>
                <th className="px-3 py-2">On hand</th>
                <th className="px-3 py-2">Low at</th>
                <th className="px-3 py-2">Reorder at</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {shownRows.map((r) => (
                <tr key={r.shopProductId} className="align-top">
                  <td className="px-3 py-2">
                    {r.productName} <span className="text-xs text-ink-400">{r.productCode}</span>
                    {editing === r.shopProductId ? (
                      <div className="mt-2 space-y-2 rounded-lg border border-cream-200 p-3">
                        <div className="grid gap-2 sm:grid-cols-3">
                          <Field label="Low-stock threshold (0 = inherit)">
                            <input className={inputClass} inputMode="numeric" value={form.low} onChange={(e) => setForm({ ...form, low: e.target.value })} />
                          </Field>
                          <Field label="Reorder level (empty = inherit)">
                            <input className={inputClass} inputMode="numeric" value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} />
                          </Field>
                          <Field label="Reorder quantity">
                            <input className={inputClass} inputMode="numeric" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
                          </Field>
                        </div>
                        <label className="flex items-center gap-2 text-xs">
                          <input type="checkbox" checked={form.off} onChange={(e) => setForm({ ...form, off: e.target.checked })} /> No stock alerts for this product
                        </label>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={async () => {
                              const ok = await call(`/api/shop-products/${r.shopProductId}/stock-settings`, {
                                lowStockThreshold: num(form.low) ?? 0,
                                reorderLevel: num(form.level),
                                reorderQuantity: num(form.qty),
                                stockAlertsDisabled: form.off,
                              });
                              if (ok) setEditing(null);
                            }}
                          >
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{r.unit}</td>
                  <td className="px-3 py-2 font-medium">{r.available}</td>
                  <td className="px-3 py-2">
                    <input
                      aria-label={`Price of ${r.productName}`}
                      className={`${inputClass} w-24`}
                      inputMode="decimal"
                      placeholder="Enter price"
                      value={
                        priceEdits[r.shopProductId] ??
                        (r.onlinePricePaise != null ? String(paiseToRupees(r.onlinePricePaise)) : "")
                      }
                      onChange={(e) => setPriceEdits({ ...priceEdits, [r.shopProductId]: e.target.value })}
                    />
                    {priceErrors[r.shopProductId] ? (
                      <span className="mt-1 block text-xs text-red-600">{priceErrors[r.shopProductId]}</span>
                    ) : r.onlinePricePaise == null ? (
                      <span className="mt-1 block text-xs text-ink-500">Needs a price</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{r.reserved}</td>
                  <td className="px-3 py-2">{r.onHand}</td>
                  <td className="px-3 py-2">
                    {r.thresholds.alertsDisabled ? "off" : r.thresholds.lowStock || "—"}
                    <span className="block text-xs text-ink-400">{r.thresholds.alertsDisabled ? "" : SOURCE_LABEL[r.thresholds.source.lowStock]}</span>
                  </td>
                  <td className="px-3 py-2">
                    {r.thresholds.reorderLevel ?? "—"}
                    {r.thresholds.reorderQuantity ? <span className="block text-xs text-ink-400">order {r.thresholds.reorderQuantity}</span> : null}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    {r.reorderNeeded ? <Badge tone="warning">reorder</Badge> : null}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="text-xs font-medium text-kesari-700 underline"
                      onClick={() => {
                        setEditing(r.shopProductId);
                        setForm({
                          low: String(r.own.lowStockThreshold),
                          level: r.own.reorderLevel != null ? String(r.own.reorderLevel) : "",
                          qty: r.own.reorderQuantity != null ? String(r.own.reorderQuantity) : "",
                          off: r.own.stockAlertsDisabled,
                        });
                      }}
                    >
                      Thresholds
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p className="mt-2 text-xs text-ink-500">
          <strong>Available</strong> can be sold now; <strong>reserved</strong> is committed to orders not yet delivered;{" "}
          <strong>on hand</strong> is both together. Alerts compare <em>available</em> stock with your thresholds.
        </p>
      </section>
    </div>
  );
}
