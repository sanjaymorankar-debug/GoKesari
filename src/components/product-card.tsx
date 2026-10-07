"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { SafeImage } from "@/components/safe-image";
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
  /** Current quantity in cart for this product. */
  cartQuantity?: number;
  /** F8: a live shop offer's online price and title, when one applies. */
  offerPricePaise?: number | null;
  offerTitle?: string | null;
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
  const [quantity, setQuantity] = useState(1);
  const [inCart, setInCart] = useState(product.cartQuantity ?? 0);
  const [cartQuantity, setCartQuantity] = useState(product.cartQuantity ?? 0);
  const [showConfirm, setShowConfirm] = useState(false);

  const outOfStock = product.trackInventory && product.onlineStock <= 0;
  const canBuyOnline =
    product.onlineSaleEnabled &&
    product.onlinePricePaise != null &&
    product.isAvailable &&
    !outOfStock;

  const maxQuantity = product.trackInventory ? product.onlineStock : 99;
  const quantityDisplay = showConfirm ? "✓ Added" : cartQuantity;

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
        quantity: quantity,
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not add to cart.");
      return;
    }
    setInCart(quantity);
    setCartQuantity(cartQuantity + quantity);
    setShowConfirm(true);
    setTimeout(() => setShowConfirm(false), 1500);
    startTransition(() => router.refresh());
  }

  async function updateCartQuantity(newQty: number) {
    if (newQty < 0) return;
    setError(null);

    if (newQty === 0) {
      setCartQuantity(0);
      setInCart(0);
      return;
    }

    const diff = newQty - cartQuantity;
    const response = await fetch("/api/cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shopProductId: product.shopProductId,
        quantity: diff,
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not update cart.");
      return;
    }
    setCartQuantity(newQty);
    startTransition(() => router.refresh());
  }

  return (
    <Card
      className="flex h-full flex-col p-4"
      data-testid="product-card"
      data-product-name={product.productName}
    >
      <SafeImage
        src={product.imageUrl}
        alt={product.productName}
        className="mb-3 h-32 w-full rounded-lg bg-cream-100 object-cover"
      />
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
          {product.onlinePricePaise != null && product.offerPricePaise != null ? (
            <span className="text-xs text-ink-400 line-through" data-testid="offer-list-price">
              <Money paise={product.onlinePricePaise} />
            </span>
          ) : null}
          {product.onlinePricePaise != null ? (
            <span className="text-base font-semibold text-ink-900">
              <Money paise={product.offerPricePaise ?? product.onlinePricePaise} />
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
          {product.onlinePricePaise == null && product.offlinePricePaise == null ? (
            <span className="text-sm font-medium text-ink-700">Price on request</span>
          ) : null}
        </div>
        {product.offerTitle ? (
          <p className="mt-0.5 text-xs font-medium text-leaf-700" data-testid="product-offer">
            {product.offerTitle}
          </p>
        ) : null}

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

        <div className="mt-3 space-y-2">
          {cartQuantity > 0 ? (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  aria-label={`Decrease quantity of ${product.productName}`}
                  onClick={() => updateCartQuantity(cartQuantity - 1)}
                >
                  −
                </Button>
                <span className="w-8 text-center text-sm font-medium tabular-nums">
                  {showConfirm ? "✓" : cartQuantity}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending || cartQuantity >= maxQuantity}
                  aria-label={`Increase quantity of ${product.productName}`}
                  onClick={() => updateCartQuantity(cartQuantity + 1)}
                >
                  +
                </Button>
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => updateCartQuantity(0)}
                className="text-xs"
              >
                Remove
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              {canBuyOnline ? (
                <>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending || quantity <= 1}
                      aria-label={`Decrease quantity`}
                      onClick={() => setQuantity(Math.max(1, quantity - 1))}
                    >
                      −
                    </Button>
                    <span className="w-8 text-center text-sm font-medium tabular-nums">
                      {quantity}
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending || quantity >= maxQuantity}
                      aria-label={`Increase quantity`}
                      onClick={() => setQuantity(Math.min(maxQuantity, quantity + 1))}
                    >
                      +
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    onClick={addToCart}
                    disabled={pending}
                    className="flex-1"
                  >
                    Add to cart
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="secondary" disabled className="flex-1">
                  {product.onlinePricePaise == null && product.offlinePricePaise == null
                    ? "Ask shop"
                    : product.offlineSaleEnabled && !product.onlineSaleEnabled
                      ? "In-shop only"
                      : "Unavailable"}
                </Button>
              )}
            </div>
          )}

          {canBuyOnline && product.subscribable ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                router.push(`/subscribe/${product.shopProductId}`)
              }
              className="w-full"
            >
              Subscribe
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
