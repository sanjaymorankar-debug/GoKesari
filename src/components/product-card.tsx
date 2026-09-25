"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { AvailabilityBadge, Button, Card, Money } from "@/components/ui";

export interface ProductCardData {
  shopProductId: string;
  productName: string;
  categoryName: string;
  unit: string;
  imageUrl: string | null;
  onlinePricePaise: number | null;
  offlinePricePaise: number | null;
  onlineSaleEnabled: boolean;
  offlineSaleEnabled: boolean;
  isAvailable: boolean;
  trackInventory: boolean;
  onlineStock: number;
  subscribable: boolean;
  shopName?: string;
  shopSlug?: string;
  /** Catalogue product id — enables the "Compare prices" link (GS-021/022). */
  productId?: string;
  /** Distance to the shop when a customer location is set (GS-020). */
  distanceKm?: number | null;
}

/**
 * Product tile.
 *
 * Shows both prices when they differ (§13) and never offers "Add to cart" for
 * something that is not online-purchasable (§12) — though the server re-checks
 * regardless, since UI state is only a hint.
 */
export function ProductCard({
  product,
  signedIn,
}: {
  product: ProductCardData;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  const outOfStock = product.trackInventory && product.onlineStock <= 0;
  const canBuyOnline =
    product.onlineSaleEnabled &&
    product.onlinePricePaise != null &&
    product.isAvailable &&
    !outOfStock;

  async function addToCart() {
    if (!signedIn) {
      router.push("/signin");
      return;
    }
    setError(null);
    const response = await fetch("/api/cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shopProductId: product.shopProductId,
        quantity: 1,
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not add to cart.");
      return;
    }
    setAdded(true);
    startTransition(() => router.refresh());
  }

  return (
    <Card
      className="flex h-full flex-col p-4"
      data-testid="product-card"
      data-product-name={product.productName}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-ink-900">
            {product.productName}
          </h3>
          <p className="text-xs text-ink-500">{product.categoryName}</p>
        </div>
        <AvailabilityBadge
          onlineSaleEnabled={product.onlineSaleEnabled}
          offlineSaleEnabled={product.offlineSaleEnabled}
          isAvailable={product.isAvailable}
          outOfStock={outOfStock}
        />
      </div>

      {product.shopName && product.shopSlug ? (
        <p className="mb-2 text-xs text-ink-500">
          at {product.shopName}
          {product.distanceKm != null ? ` · ${product.distanceKm} km` : null}
        </p>
      ) : null}

      <div className="mt-auto">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          {product.onlinePricePaise != null ? (
            <span className="text-base font-semibold text-ink-900">
              <Money paise={product.onlinePricePaise} />
              <span className="text-xs font-normal text-ink-500">
                {" "}
                / {product.unit} online
              </span>
            </span>
          ) : null}
          {product.offlinePricePaise != null &&
          product.offlinePricePaise !== product.onlinePricePaise ? (
            <span className="text-xs text-ink-500">
              <Money paise={product.offlinePricePaise} /> in shop
            </span>
          ) : null}
        </div>

        {product.productId ? (
          <Link
            href={`/products/${product.productId}`}
            className="mt-1 inline-block text-xs font-medium text-kesari-600 hover:underline"
          >
            Compare prices at other shops →
          </Link>
        ) : null}

        {error ? (
          <p className="mt-2 text-xs text-red-600" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-3 flex gap-2">
          {canBuyOnline ? (
            <Button
              size="sm"
              onClick={addToCart}
              disabled={pending}
              className="flex-1"
            >
              {added ? "Added ✓" : "Add to cart"}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" disabled className="flex-1">
              {product.offlineSaleEnabled && !product.onlineSaleEnabled
                ? "In-shop only"
                : "Unavailable"}
            </Button>
          )}

          {canBuyOnline && product.subscribable ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                router.push(`/subscribe/${product.shopProductId}`)
              }
            >
              Subscribe
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
