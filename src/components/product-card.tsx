"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { SafeImage } from "@/components/safe-image";
import { AvailabilityBadge, Button, Card, Money } from "@/components/ui";
import type { CartLineQuantity, CartSummary } from "@/server/services/cart";

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
  /** F8: a live shop offer's online price and title, when one applies. */
  offerPricePaise?: number | null;
  offerTitle?: string | null;
  /** Module 1: the shop's short description (or the master's). */
  shortDescription?: string | null;
  /** Module 1: this shop's product page (its photos and long description). */
  detailsHref?: string;
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
  cartLine = null,
}: {
  product: ProductCardData;
  signedIn: boolean;
  /** This product's line in the viewer's cart when the page was rendered. */
  cartLine?: CartLineQuantity | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** How many to add, chosen before the item is in the cart. */
  const [quantity, setQuantity] = useState(1);
  /** This product's cart line, as the server last reported it. */
  const [line, setLine] = useState<CartLineQuantity | null>(cartLine);
  // router.refresh() re-renders the page with the cart as the server now has
  // it; adopt that line in place of the one this card last saw.
  const [renderedCartLine, setRenderedCartLine] = useState(cartLine);
  if (!sameCartLine(cartLine, renderedCartLine)) {
    setRenderedCartLine(cartLine);
    setLine(cartLine);
  }
  const [justAdded, setJustAdded] = useState(false);

  const outOfStock = product.trackInventory && product.onlineStock <= 0;
  const canBuyOnline =
    product.onlineSaleEnabled &&
    product.onlinePricePaise != null &&
    product.isAvailable &&
    !outOfStock;

  // The cart API takes at most 99 of a line.
  const maxQuantity = Math.min(99, product.trackInventory ? product.onlineStock : 99);
  const disabled = busy || pending;

  /**
   * Sends one cart request and keeps this product's line from the cart the
   * server returns, so the count shown is always the cart's real quantity.
   */
  async function updateCart(url: string, init: RequestInit, failure: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        ...init,
        headers: { "Content-Type": "application/json" },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? failure);
        return false;
      }
      const found = (payload as CartSummary | null)?.groups
        .flatMap((group) => group.lines)
        .find((l) => l.shopProductId === product.shopProductId);
      setLine(found ? { cartItemId: found.cartItemId, quantity: found.quantity } : null);
      startTransition(() => router.refresh());
      return true;
    } catch {
      setError(failure);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addToCart() {
    if (!signedIn) {
      router.push("/signin");
      return;
    }
    const added = await updateCart(
      "/api/cart",
      { method: "POST", body: JSON.stringify({ shopProductId: product.shopProductId, quantity }) },
      "Could not add to cart.",
    );
    if (added) {
      setQuantity(1);
      setJustAdded(true);
      setTimeout(() => setJustAdded(false), 1500);
    }
  }

  /** Sets the line's quantity; 0 removes it (PATCH /api/cart/items/:id). */
  function setCartQuantity(next: number) {
    if (!line) return;
    void updateCart(
      `/api/cart/items/${line.cartItemId}`,
      { method: "PATCH", body: JSON.stringify({ quantity: next }) },
      "Could not update your cart.",
    );
  }

  return (
    <Card
      className="flex h-full flex-col p-4"
      data-testid="product-card"
      data-product-name={product.productName}
    >
      <SafeImage
        src={product.imageUrl}
        size="medium"
        alt={product.productName}
        className="mb-3 h-32 w-full rounded-lg bg-cream-100 object-cover"
      />
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-ink-900">
            {product.detailsHref ? (
              <Link href={product.detailsHref} className="hover:text-kesari-700">
                {product.productName}
              </Link>
            ) : (
              product.productName
            )}
          </h3>
          <p className="text-xs text-ink-500">{product.categoryName}</p>
          {product.shortDescription ? (
            <p className="mt-1 line-clamp-2 text-xs text-ink-600" data-testid="product-short-description">
              {product.shortDescription}
            </p>
          ) : null}
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

        {/* Buttons here are 8px apart, so tap areas are capped at 36px to
            keep them from meeting. */}
        <div className="mt-3 space-y-2">
          {justAdded ? (
            <div className="flex">
              <Button size="sm" disabled className="flex-1">
                Added ✓
              </Button>
            </div>
          ) : line ? (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  className="tap-target [--tap-h:36px] [--tap-w:36px]"
                  disabled={disabled}
                  aria-label={`Decrease quantity of ${product.productName} in cart`}
                  onClick={() => setCartQuantity(line.quantity - 1)}
                >
                  −
                </Button>
                <span className="w-8 text-center text-sm font-medium tabular-nums" aria-live="polite">
                  {line.quantity}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  className="tap-target [--tap-h:36px] [--tap-w:36px]"
                  disabled={disabled || line.quantity >= maxQuantity}
                  aria-label={`Increase quantity of ${product.productName} in cart`}
                  onClick={() => setCartQuantity(line.quantity + 1)}
                >
                  +
                </Button>
              </div>
              <Button
                size="sm"
                variant="secondary"
                className="tap-target [--tap-h:36px]"
                disabled={disabled}
                aria-label={`Remove ${product.productName} from cart`}
                onClick={() => setCartQuantity(0)}
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
                      className="tap-target [--tap-h:36px] [--tap-w:36px]"
                      disabled={disabled || quantity <= 1}
                      aria-label={`Decrease quantity of ${product.productName} to add`}
                      onClick={() => setQuantity(Math.max(1, quantity - 1))}
                    >
                      −
                    </Button>
                    <span className="w-8 text-center text-sm font-medium tabular-nums" aria-live="polite">
                      {quantity}
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="tap-target [--tap-h:36px] [--tap-w:36px]"
                      disabled={disabled || quantity >= maxQuantity}
                      aria-label={`Increase quantity of ${product.productName} to add`}
                      onClick={() => setQuantity(Math.min(maxQuantity, quantity + 1))}
                    >
                      +
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    onClick={addToCart}
                    disabled={disabled}
                    className="tap-target flex-1 [--tap-h:36px]"
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
              className="tap-target w-full [--tap-h:36px]"
            >
              Subscribe
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function sameCartLine(a: CartLineQuantity | null, b: CartLineQuantity | null): boolean {
  return a?.cartItemId === b?.cartItemId && a?.quantity === b?.quantity;
}
