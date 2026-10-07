"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { AddProductPanel } from "@/components/add-product-panel";
import { SafeImage } from "@/components/safe-image";
import {
  Alert,
  AvailabilityBadge,
  Badge,
  Button,
  Card,
  EmptyState,
  Money,
  inputClass,
} from "@/components/ui";
import { paiseToRupees, rupeesToPaise } from "@/lib/money";

interface ManagedProduct {
  id: string;
  productName: string;
  categoryName: string;
  unit: string;
  /** The photo customers see; a placeholder when absent. */
  imageUrl?: string | null;
  onlinePricePaise: number | null;
  offlinePricePaise: number | null;
  onlineSaleEnabled: boolean;
  offlineSaleEnabled: boolean;
  onlineStock: number;
  trackInventory: boolean;
  isActive: boolean;
  isAvailable: boolean;
  /** The shop no longer carries this product's category: hidden from customers until it does again. */
  paused?: boolean;
}

interface Suggestion {
  id: string;
  name: string;
  unit: string;
  categoryName: string;
  department: string;
}

/**
 * Shop owner catalogue management (§11–§13).
 *
 * Enforces the same rule the database does — enabling a channel requires that
 * channel's price — so the owner is told before submitting rather than after.
 */
export function ShopProductManager({
  shopId,
  department,
  applyPriceImmediately = true,
  products,
  suggestions,
}: {
  shopId: string;
  /** The shop's own department/type — scopes category choices and searches. */
  department: string;
  /** False when an operator/admin is managing a shop they don't own. */
  applyPriceImmediately?: boolean;
  products: ManagedProduct[];
  suggestions: Suggestion[];
}) {
  return (
    <div className="space-y-8">
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-ink-900">Add a product</h2>
          <AddProductPanel
            shopId={shopId}
            department={department}
            applyPriceImmediately={applyPriceImmediately}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-ink-900">
          My products ({products.length})
        </h2>
        {products.length === 0 ? (
          <EmptyState title="No products listed yet — add some below." />
        ) : (
          <div className="space-y-2">
            {products.map((p) => (
              <ProductRow key={p.id} product={p} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold text-ink-900">
          Add products
        </h2>
        <p className="mb-3 text-sm text-ink-500">
          Suggested for your shop type — choose the ones you actually sell.
        </p>
        {suggestions.length === 0 ? (
          <EmptyState title="You've listed every suggested product." />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {suggestions.slice(0, 24).map((s) => (
              <AddProductRow key={s.id} shopId={shopId} suggestion={s} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ProductRow({ product }: { product: ManagedProduct }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [onlineEnabled, setOnlineEnabled] = useState(product.onlineSaleEnabled);
  const [offlineEnabled, setOfflineEnabled] = useState(
    product.offlineSaleEnabled,
  );
  const [onlinePrice, setOnlinePrice] = useState(
    product.onlinePricePaise != null
      ? String(paiseToRupees(product.onlinePricePaise))
      : "",
  );
  const [offlinePrice, setOfflinePrice] = useState(
    product.offlinePricePaise != null
      ? String(paiseToRupees(product.offlinePricePaise))
      : "",
  );
  const [stock, setStock] = useState(String(product.onlineStock));
  const [available, setAvailable] = useState(product.isAvailable);

  async function save() {
    // Mirror of the server rule (§13) so the owner gets immediate feedback.
    if (onlineEnabled && !onlinePrice) {
      setError("An online price is required when online selling is enabled.");
      return;
    }
    if (offlineEnabled && !offlinePrice) {
      setError("An offline price is required when offline selling is enabled.");
      return;
    }

    setBusy(true);
    setError(null);
    const response = await fetch(`/api/shop-products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        onlineSaleEnabled: onlineEnabled,
        offlineSaleEnabled: offlineEnabled,
        onlinePricePaise: onlinePrice ? rupeesToPaise(Number(onlinePrice)) : null,
        offlinePricePaise: offlinePrice
          ? rupeesToPaise(Number(offlinePrice))
          : null,
        onlineStock: Number(stock) || 0,
        isAvailable: available,
      }),
    });
    setBusy(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not save.");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  async function remove() {
    if (!window.confirm(`Remove ${product.productName} from your shop?`)) return;
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/shop-products/${product.id}`, {
      method: "DELETE",
    });
    setBusy(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not remove this product.");
      return;
    }
    router.refresh();
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <a href={`/shop/products/${product.id}/images`} aria-label={`Photos of ${product.productName}`} className="shrink-0">
            <SafeImage
              src={product.imageUrl}
              alt=""
              className="h-12 w-12 rounded-lg border border-cream-200 bg-cream-100 object-cover"
            />
          </a>
          <div>
            <p className="font-medium text-ink-900">{product.productName}</p>
            <p className="text-xs text-ink-500">{product.categoryName}</p>
            {product.paused ? (
              <p className="mt-1 text-xs font-medium text-amber-700" data-testid="listing-paused">
                Paused — this shop no longer carries {product.categoryName}. Add the category back to sell it again.
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {product.onlinePricePaise != null ? (
            <span className="text-sm">
              <Money paise={product.onlinePricePaise} /> online
            </span>
          ) : null}
          {product.offlinePricePaise != null ? (
            <span className="text-sm text-ink-500">
              <Money paise={product.offlinePricePaise} /> in shop
            </span>
          ) : null}
          <AvailabilityBadge
            onlineSaleEnabled={product.onlineSaleEnabled}
            offlineSaleEnabled={product.offlineSaleEnabled}
            isAvailable={product.isAvailable}
            outOfStock={product.trackInventory && product.onlineStock <= 0}
          />
          {product.trackInventory ? (
            <Badge>{product.onlineStock} in stock</Badge>
          ) : null}
          <a
            href={`/shop/products/${product.id}/images`}
            className="rounded-lg border border-cream-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-cream-100"
          >
            Photos
          </a>
          <Button size="sm" variant="secondary" onClick={() => setOpen((v) => !v)}>
            {open ? "Close" : "Edit"}
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={remove}>
            Remove
          </Button>
        </div>
      </div>

      {error && !open ? (
        <p className="mt-2 text-xs text-red-600">{error}</p>
      ) : null}

      {open ? (
        <div className="mt-4 grid gap-3 border-t border-cream-200 pt-4 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={onlineEnabled}
              onChange={(e) => setOnlineEnabled(e.target.checked)}
            />
            Sell online
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={offlineEnabled}
              onChange={(e) => setOfflineEnabled(e.target.checked)}
            />
            Sell in shop
          </label>

          <label className="text-sm text-ink-700">
            Online price (₹ per {product.unit})
            <input
              type="number"
              min={0}
              step={0.5}
              value={onlinePrice}
              onChange={(e) => setOnlinePrice(e.target.value)}
              className={inputClass}
              disabled={!onlineEnabled}
            />
          </label>
          <label className="text-sm text-ink-700">
            In-shop price (₹ per {product.unit})
            <input
              type="number"
              min={0}
              step={0.5}
              value={offlinePrice}
              onChange={(e) => setOfflinePrice(e.target.value)}
              className={inputClass}
              disabled={!offlineEnabled}
            />
          </label>

          <label className="text-sm text-ink-700">
            Online stock
            <input
              type="number"
              min={0}
              value={stock}
              onChange={(e) => setStock(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={available}
              onChange={(e) => setAvailable(e.target.checked)}
            />
            Available today
          </label>

          {error ? (
            <div className="sm:col-span-2">
              <Alert tone="danger">{error}</Alert>
            </div>
          ) : null}

          <div className="sm:col-span-2">
            <Button disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save changes"}
            </Button>
            <p className="mt-2 text-xs text-ink-500">
              Price changes apply to future orders only — completed orders keep
              their original price.
            </p>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function AddProductRow({
  shopId,
  suggestion,
}: {
  shopId: string;
  suggestion: Suggestion;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [price, setPrice] = useState("");

  async function add() {
    if (!price) {
      setError("Enter an online price.");
      return;
    }
    setBusy(true);
    setError(null);

    const paise = rupeesToPaise(Number(price));
    const response = await fetch(`/api/shops/${shopId}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: suggestion.id,
        onlineSaleEnabled: true,
        onlinePricePaise: paise,
        offlineSaleEnabled: true,
        offlinePricePaise: paise,
        trackInventory: true,
        onlineStock: 100,
        offlineStock: 100,
      }),
    });
    setBusy(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not add the product.");
      return;
    }
    setPrice("");
    router.refresh();
  }

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink-900">
            {suggestion.name}
          </p>
          <p className="text-xs text-ink-500">
            {suggestion.categoryName} · per {suggestion.unit}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min={0}
            step={0.5}
            placeholder="₹"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            aria-label={`Price for ${suggestion.name}`}
            className="w-20 rounded-lg border border-cream-200 px-2 py-1 text-sm"
          />
          <Button size="sm" disabled={busy} onClick={add}>
            Add
          </Button>
        </div>
      </div>
      {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
    </Card>
  );
}
