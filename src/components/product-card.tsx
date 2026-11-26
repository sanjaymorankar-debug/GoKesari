"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { FavouriteHeart } from "@/components/favourites/favourite-heart";
import { useGuestCart, useGuestCartEnabled } from "@/components/guest-cart/guest-cart-context";
import { AddToListButton } from "@/components/purchase-lists/add-to-list-button";
import { SafeImage } from "@/components/safe-image";
import { categoryEmoji, priceUnitLabel } from "@/lib/board/product-look";
import { formatQuantity } from "@/lib/money";
import { addToGuestCart, guestCartRefusal, setGuestCartQuantity } from "@/lib/guest-cart";
import { discountPercent } from "@/lib/price-rules";
import { cartQuantityStep, formatStock, quantityToMilli, roundStock, type ProductKind } from "@/lib/stock-quantity";
import { AvailabilityBadge, Button, Card, Money } from "@/components/ui";
import type { CartLineQuantity, CartSummary } from "@/server/services/cart";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Module 6 (docs/hindi-marathi-2026-11): the product tile's wording. Names, units and prices stay as they are. */
const T = {
  addFailed: L("Could not add to cart.", "कार्ट में नहीं जुड़ सका।", "कार्टमध्ये जोडता आले नाही."),
  updateFailed: L("Could not update your cart.", "आपका कार्ट अपडेट नहीं हो सका।", "तुमचे कार्ट अपडेट करता आले नाही."),
  kmAway: L("{km} km away", "{km} किमी दूर", "{km} किमी दूर"),
  online: L(" online", " ऑनलाइन", " ऑनलाइन"),
  off: L("{n}% off", "{n}% छूट", "{n}% सूट"),
  inShop: L("in shop", "दुकान में", "दुकानात"),
  priceOnRequest: L("Price on request", "दाम पूछने पर", "किंमत विचारल्यावर"),
  compareN: L("Compare {n} prices", "{n} दाम मिलाएँ", "{n} दर तुलना करा"),
  compareOthers: L("Compare prices at other shops →", "दूसरी दुकानों के दाम मिलाएँ →", "इतर दुकानांचे दर तुलना करा →"),
  added: L("Added ✓", "जुड़ गया ✓", "जोडले ✓"),
  decreaseInCart: L("Decrease quantity of {name} in cart", "कार्ट में {name} की मात्रा कम करें", "कार्टमधील {name} चे प्रमाण कमी करा"),
  increaseInCart: L("Increase quantity of {name} in cart", "कार्ट में {name} की मात्रा बढ़ाएँ", "कार्टमधील {name} चे प्रमाण वाढवा"),
  removeFromCart: L("Remove {name} from cart", "{name} को कार्ट से हटाएँ", "{name} कार्टमधून काढा"),
  remove: L("Remove", "हटाएँ", "काढा"),
  decreaseToAdd: L("Decrease quantity of {name} to add", "जोड़ने के लिए {name} की मात्रा कम करें", "जोडण्यासाठी {name} चे प्रमाण कमी करा"),
  increaseToAdd: L("Increase quantity of {name} to add", "जोड़ने के लिए {name} की मात्रा बढ़ाएँ", "जोडण्यासाठी {name} चे प्रमाण वाढवा"),
  addToCart: L("Add to cart", "कार्ट में जोड़ें", "कार्टमध्ये जोडा"),
  askShop: L("Ask shop", "दुकान से पूछें", "दुकानाला विचारा"),
  inShopOnly: L("In-shop only", "सिर्फ़ दुकान में", "फक्त दुकानात"),
  unavailable: L("Unavailable", "उपलब्ध नहीं", "उपलब्ध नाही"),
  subscribe: L("Subscribe", "सब्सक्राइब करें", "सदस्यता घ्या"),
} as const;

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
  /** D-95: a loose good steps in parts of a unit (250 g of a 1 kg listing); packaged goods in whole units. */
  kind?: ProductKind;
  /** Size of one sellable unit in milli of `unit` (1 kg → 1000). */
  unitSizeMilli?: number;
  shopName?: string;
  /** Shown bold on the first line of the card, the shop name under it. */
  shopOwnerName?: string;
  shopSlug?: string;
  /** Catalogue product id — enables the "Compare prices" link (GS-021/022). */
  productId?: string;
  /** docs/homepage-uiux-2026-10 (F4): nearby shops selling it — from 2, the link reads "Compare N prices". */
  compareCount?: number;
  /** Distance to the shop when a customer location is set (GS-020). */
  distanceKm?: number | null;
  /** F8: a live shop offer's online price and title, when one applies. */
  offerPricePaise?: number | null;
  offerTitle?: string | null;
  /** Module 1: the shop's short description (or the master's). */
  shortDescription?: string | null;
  /** Module 1: this shop's product page (its photos and long description). */
  detailsHref?: string;
  /** The master MRP: struck through, with "x% off", when the price is below it (TC-CAT-008). */
  mrpPaise?: number | null;
  /**
   * docs/search-brand-barcode-favourites-2026-11: the catalogue product the heart saves. Set only while
   * the flag brand_barcode_favourites_enabled is on — without it the card has no heart.
   */
  favouriteProductId?: string;
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
  lang = "en",
}: {
  product: ProductCardData;
  signedIn: boolean;
  /** Module 6: the tile's language (product and shop names stay as entered). */
  lang?: Lang;
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
  // docs/guest-cart-2026-11: a signed-out shopper's cart is kept in the browser (flag guest_cart_enabled).
  const guestCartOn = useGuestCartEnabled();
  const guestCart = !signedIn && guestCartOn;
  const guestCartState = useGuestCart(guestCart);
  const guestLine = guestCart ? guestCartState.lines.find((l) => l.shopProductId === product.shopProductId) : undefined;
  const shownLine: CartLineQuantity | null = guestCart
    ? guestLine
      ? { cartItemId: guestLine.shopProductId, quantity: guestLine.quantity }
      : null
    : line;

  const outOfStock = product.trackInventory && product.onlineStock <= 0;
  const canBuyOnline =
    product.onlineSaleEnabled &&
    product.onlinePricePaise != null &&
    product.isAvailable &&
    !outOfStock;

  // TC-CAT-008: the MRP struck through and the saving, against the price the customer pays now.
  const shownPricePaise = product.offerPricePaise ?? product.onlinePricePaise;
  const percentOff = discountPercent(product.mrpPaise, shownPricePaise);
  const showMrp = percentOff != null;

  // The cart API takes at most 99 of a line.
  const maxQuantity = Math.min(99, product.trackInventory ? product.onlineStock : 99);
  // D-95: − / + move a loose good by 250 g / 250 ml where its unit allows; packaged goods by one.
  const cartProduct = { kind: product.kind ?? ("PACKAGED" as const), unit: product.unit, unitSizeMilli: product.unitSizeMilli ?? 1000 };
  const step = cartQuantityStep(cartProduct);
  const loose = cartProduct.kind === "LOOSE";
  /** A quantity as the customer reads it: "2" packs, or "250 g" / "1.5 kg" of a loose good. */
  const shown = (q: number) => (loose ? formatQuantity(quantityToMilli(q, cartProduct.unitSizeMilli), product.unit) : formatStock(q));
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
        setError(errorText(payload?.error?.message ?? failure, lang, payload?.error?.code));
        return false;
      }
      const found = (payload as CartSummary | null)?.groups
        .flatMap((group) => group.lines)
        .find((l) => l.shopProductId === product.shopProductId);
      setLine(found ? { cartItemId: found.cartItemId, quantity: found.quantity } : null);
      startTransition(() => router.refresh());
      return true;
    } catch {
      setError(errorText(failure, lang));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addToCart() {
    if (guestCart) {
      setError(null);
      const change = addToGuestCart(product.shopProductId, quantity);
      if (!change.ok) {
        setError(guestCartRefusal(change.reason));
        return;
      }
      setQuantity(1);
      setJustAdded(true);
      setTimeout(() => setJustAdded(false), 1500);
      return;
    }
    if (!signedIn) {
      router.push("/signin");
      return;
    }
    const added = await updateCart(
      "/api/cart",
      { method: "POST", body: JSON.stringify({ shopProductId: product.shopProductId, quantity }) },
      lang === "en" ? "Could not add to cart." : tr(T.addFailed, lang),
    );
    if (added) {
      setQuantity(1);
      setJustAdded(true);
      setTimeout(() => setJustAdded(false), 1500);
    }
  }

  /** Sets the line's quantity; 0 removes it (PATCH /api/cart/items/:id). */
  function setCartQuantity(next: number) {
    if (guestCart) {
      setGuestCartQuantity(product.shopProductId, next);
      return;
    }
    if (!line) return;
    void updateCart(
      `/api/cart/items/${line.cartItemId}`,
      { method: "PATCH", body: JSON.stringify({ quantity: next }) },
      lang === "en" ? "Could not update your cart." : tr(T.updateFailed, lang),
    );
  }

  return (
    <Card
      className="flex h-full flex-col p-2.5 sm:p-4"
      data-testid="product-card"
      data-product-name={product.productName}
    >
      {product.shopName ? (
        <div className="mb-2 min-w-0" data-testid="card-seller">
          {product.shopOwnerName ? (
            <p className="line-clamp-2 break-words text-sm font-bold leading-tight text-ink-900" data-testid="card-owner">
              {product.shopOwnerName}
            </p>
          ) : null}
          <p className={product.shopOwnerName ? "mt-0.5 line-clamp-2 break-words text-xs font-medium text-ink-600" : "line-clamp-2 break-words text-sm font-bold text-ink-900"} data-testid="card-shop">
            {product.shopName}
          </p>
        </div>
      ) : null}
      {product.favouriteProductId ? (
        <div className="relative">
          <SafeImage
            src={product.imageUrl}
            size="medium"
            alt={product.productName}
            fallbackEmoji={categoryEmoji(product.categoryName, product.productName)}
            className="mb-2 h-24 w-full rounded-lg bg-white object-contain p-1 ring-1 ring-cream-100 sm:mb-3 sm:h-32"
          />
          <FavouriteHeart productId={product.favouriteProductId} productName={product.productName} signedIn={signedIn} className="absolute right-1 top-1" />
        </div>
      ) : (
        <SafeImage
          src={product.imageUrl}
          size="medium"
          alt={product.productName}
          fallbackEmoji={categoryEmoji(product.categoryName, product.productName)}
          className="mb-2 h-24 w-full rounded-lg bg-white object-contain p-1 ring-1 ring-cream-100 sm:mb-3 sm:h-32"
        />
      )}
      <div className="mb-2 flex flex-col items-start gap-1 sm:flex-row sm:justify-between sm:gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-ink-900">
            {product.detailsHref ? (
              <Link prefetch={false} href={product.detailsHref} className="hover:text-kesari-700">
                {product.productName}
              </Link>
            ) : (
              product.productName
            )}
          </h3>
          <p className="text-xs text-ink-500">{product.categoryName}</p>
          {product.shortDescription ? (
            <p className="mt-1 line-clamp-2 hidden text-xs text-ink-600 sm:block" data-testid="product-short-description">
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

      {product.distanceKm != null && product.shopName ? (
        <p className="mb-2 text-xs text-ink-500">{tr(T.kmAway, lang).replace("{km}", String(product.distanceKm))}</p>
      ) : null}

      <div className="mt-auto">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          {showMrp ? (
            <span className="text-xs text-ink-500" data-testid="card-mrp">
              MRP{" "}
              <span className="line-through">
                <Money paise={product.mrpPaise!} />
              </span>
            </span>
          ) : product.onlinePricePaise != null && product.offerPricePaise != null ? (
            <span className="text-xs text-ink-500 line-through" data-testid="offer-list-price">
              <Money paise={product.onlinePricePaise} />
            </span>
          ) : null}
          {product.onlinePricePaise != null ? (
            <span className="text-base font-semibold text-ink-900">
              <Money paise={product.offerPricePaise ?? product.onlinePricePaise} />
              <span className="text-sm font-normal text-ink-600">
                {" "}
                {priceUnitLabel(product.unit)}
                {product.offlinePricePaise != null && product.offlinePricePaise !== product.onlinePricePaise ? tr(T.online, lang) : ""}
              </span>
            </span>
          ) : null}
          {percentOff != null ? (
            <span className="text-xs font-semibold text-leaf-700" data-testid="product-discount">
              {tr(T.off, lang).replace("{n}", String(percentOff))}
            </span>
          ) : null}
          {product.offlinePricePaise != null &&
          product.offlinePricePaise !== product.onlinePricePaise ? (
            <span className="text-xs text-ink-500">
              <Money paise={product.offlinePricePaise} /> {tr(T.inShop, lang)}
            </span>
          ) : null}
          {product.onlinePricePaise == null && product.offlinePricePaise == null ? (
            <span className="text-sm font-medium text-ink-700">{tr(T.priceOnRequest, lang)}</span>
          ) : null}
        </div>
        {product.offerTitle ? (
          <p className="mt-0.5 text-xs font-medium text-leaf-700" data-testid="product-offer">
            {product.offerTitle}
          </p>
        ) : null}

        {product.productId && (product.compareCount ?? 0) >= 2 ? (
          <Link prefetch={false}
            href={`/search/compare?product=${encodeURIComponent(product.productId)}`}
            data-testid="compare-n-prices"
            className="mt-1.5 inline-flex min-h-9 items-center gap-1 self-start rounded-full bg-indigo-50 px-2.5 text-xs font-bold text-indigo-800 hover:bg-indigo-100"
          >
            <span aria-hidden>⚖</span> {tr(T.compareN, lang).replace("{n}", String(product.compareCount))}
          </Link>
        ) : product.productId ? (
          <Link prefetch={false}
            href={`/products/${product.productId}`}
            className="mt-1 inline-flex min-h-11 items-center text-sm font-medium text-kesari-700 hover:underline"
          >
            {tr(T.compareOthers, lang)}
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
                {tr(T.added, lang)}
              </Button>
            </div>
          ) : shownLine ? (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  className="tap-target [--tap-h:36px] [--tap-w:36px]"
                  disabled={disabled}
                  aria-label={tr(T.decreaseInCart, lang).replace("{name}", product.productName)}
                  onClick={() => setCartQuantity(Math.max(0, roundStock(shownLine.quantity - step)))}
                >
                  −
                </Button>
                <span className={`${loose ? "min-w-8 px-1" : "w-8"} text-center text-sm font-medium tabular-nums`} aria-live="polite">
                  {shown(shownLine.quantity)}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  className="tap-target [--tap-h:36px] [--tap-w:36px]"
                  disabled={disabled || roundStock(shownLine.quantity + step) > maxQuantity}
                  aria-label={tr(T.increaseInCart, lang).replace("{name}", product.productName)}
                  onClick={() => setCartQuantity(roundStock(shownLine.quantity + step))}
                >
                  +
                </Button>
              </div>
              <Button
                size="sm"
                variant="secondary"
                className="tap-target hidden [--tap-h:36px] sm:inline-flex"
                disabled={disabled}
                aria-label={tr(T.removeFromCart, lang).replace("{name}", product.productName)}
                onClick={() => setCartQuantity(0)}
              >
                {tr(T.remove, lang)}
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              {canBuyOnline ? (
                <>
                  {/* Phones: one full-width Add (1 item); −/+ appear once it is in the cart. */}
                  <div className="hidden items-center gap-1 sm:flex">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="tap-target [--tap-h:36px] [--tap-w:36px]"
                      disabled={disabled || quantity <= step}
                      aria-label={tr(T.decreaseToAdd, lang).replace("{name}", product.productName)}
                      onClick={() => setQuantity(Math.max(step, roundStock(quantity - step)))}
                    >
                      −
                    </Button>
                    <span className={`${loose ? "min-w-8 px-1" : "w-8"} text-center text-sm font-medium tabular-nums`} aria-live="polite">
                      {shown(quantity)}
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="tap-target [--tap-h:36px] [--tap-w:36px]"
                      disabled={disabled || roundStock(quantity + step) > maxQuantity}
                      aria-label={tr(T.increaseToAdd, lang).replace("{name}", product.productName)}
                      onClick={() => setQuantity(Math.min(maxQuantity, roundStock(quantity + step)))}
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
                    {tr(T.addToCart, lang)}
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="secondary" disabled className="flex-1">
                  {product.onlinePricePaise == null && product.offlinePricePaise == null
                    ? tr(T.askShop, lang)
                    : product.offlineSaleEnabled && !product.onlineSaleEnabled
                      ? tr(T.inShopOnly, lang)
                      : tr(T.unavailable, lang)}
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
              {tr(T.subscribe, lang)}
            </Button>
          ) : null}

          {/* docs/purchase-lists-2026-10: keep it on a weekly / monthly list (signed-in customers). */}
          {signedIn ? <AddToListButton shopProductId={product.shopProductId} productName={product.productName} /> : null}
        </div>
      </div>
    </Card>
  );
}

function sameCartLine(a: CartLineQuantity | null, b: CartLineQuantity | null): boolean {
  return a?.cartItemId === b?.cartItemId && a?.quantity === b?.quantity;
}
