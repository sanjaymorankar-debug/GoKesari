"use client";

/**
 * docs/guest-cart-2026-11: /cart for a shopper who is not signed in. The lines
 * come from the browser; prices, offers, availability and delivery fees come
 * live from POST /api/cart/preview (the same pricing as a signed-in cart).
 * "Place order" is the one step that asks for sign-in: it remembers /cart as
 * the page to come back to (D-23 return-to cookie), and after sign-in
 * GuestCartMerge moves these lines into the account cart for checkout.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useGuestCart } from "@/components/guest-cart/guest-cart-context";
import { EmptyIllustration } from "@/components/empty-illustrations";
import { SafeImage } from "@/components/safe-image";
import { Alert, Button, Card, EmptyState, LinkButton, Money } from "@/components/ui";
import { tr, type Lang } from "@/lib/board/i18n";
import { setGuestCartQuantity, type GuestCart } from "@/lib/guest-cart";
import { HOME } from "@/lib/home-i18n";
import { formatQuantity } from "@/lib/money";
import { RETURN_TO_COOKIE, RETURN_TO_MAX_AGE_S } from "@/lib/return-to";
import { roundStock, quantityToMilli } from "@/lib/stock-quantity";
import type { GuestCartPreview } from "@/server/services/guest-cart";

function linesKey(cart: GuestCart): string {
  return cart.lines.map((l) => `${l.shopProductId}:${l.quantity}`).join(",");
}

/** Remembers /cart as the page to come back to after sign-in (D-23). */
function returnToCartAfterSignIn(): void {
  try {
    const secure = window.location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${RETURN_TO_COOKIE}=${encodeURIComponent("/cart")}; max-age=${RETURN_TO_MAX_AGE_S}; path=/; samesite=lax${secure}`;
  } catch {
    // Without the cookie sign-in lands on the home page; the cart is still moved.
  }
}

export function GuestCartView({ lang }: { lang: Lang }) {
  const router = useRouter();
  const cart = useGuestCart(true);
  const key = linesKey(cart);
  const [preview, setPreview] = useState<{ key: string; data: GuestCartPreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // useGuestCart reads the browser after the first render; wait one tick so an empty first read is not shown as "empty".
    const t = setTimeout(() => setLoaded(true), 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (cart.lines.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/cart/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lines: cart.lines }),
        });
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          setError(payload?.error?.message ?? "Could not load your cart.");
          return;
        }
        const data = payload as GuestCartPreview;
        setError(null);
        setPreview({ key, data });
        // A listing that no longer exists is dropped from the browser cart.
        for (const id of data.missingShopProductIds) setGuestCartQuantity(id, 0);
      } catch {
        if (!cancelled) setError("Could not load your cart. Check your connection.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // key captures the lines; cart.lines itself is a new array on every read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (loaded && cart.lines.length === 0) {
    return (
      <EmptyState
        illustration={<EmptyIllustration name="basket" />}
        title={tr(HOME.cartEmptyTitle, lang)}
        description={tr(HOME.cartEmptyText, lang)}
        action={
          <LinkButton href="/" className="h-12 px-5 text-base font-bold">
            {tr(HOME.startShopping, lang)}
          </LinkButton>
        }
        testId="cart-empty"
      />
    );
  }

  const data = preview?.data ?? null;
  const stale = preview?.key !== key;

  return (
    <div className="space-y-4" data-testid="guest-cart">
      {error ? (
        <Alert tone="danger" title="Something went wrong">
          {error}
        </Alert>
      ) : null}
      {!data ? (
        <Card className="p-6 text-sm text-ink-600">Loading your cart…</Card>
      ) : (
        data.groups.map((group) => (
          <Card key={group.shop.id} className="p-4" data-testid="guest-cart-shop">
            <h2 className="text-base font-bold text-ink-900">
              <Link href={`/shops/${group.shop.slug}`} className="hover:underline">
                {group.shop.name}
              </Link>
            </h2>
            <ul className="mt-3 divide-y divide-cream-200">
              {group.lines.map((line) => {
                const loose = line.kind === "LOOSE";
                const shown = (q: number) => (loose ? formatQuantity(quantityToMilli(q, line.unitSizeMilli), line.unit) : String(q));
                const quantity = cart.lines.find((l) => l.shopProductId === line.shopProductId)?.quantity ?? line.quantity;
                return (
                  <li key={line.shopProductId} className="flex items-center gap-3 py-3" data-testid="guest-cart-line">
                    <SafeImage src={line.imageUrl} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink-900">{line.productName}</p>
                      {line.purchasable ? (
                        <p className="text-xs text-ink-600">
                          <Money paise={line.unitPricePaise} /> each{line.offerTitle ? ` · ${line.offerTitle}` : ""}
                        </p>
                      ) : (
                        <p className="text-xs text-red-700">{line.unavailableReason ?? "Not available now."}</p>
                      )}
                      <div className="mt-1 flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="secondary"
                          className="tap-target [--tap-h:36px] [--tap-w:36px]"
                          aria-label={`Decrease quantity of ${line.productName}`}
                          onClick={() => setGuestCartQuantity(line.shopProductId, Math.max(0, roundStock(quantity - line.quantityStep)))}
                        >
                          −
                        </Button>
                        <span className="min-w-8 px-1 text-center text-sm font-medium tabular-nums" aria-live="polite">
                          {shown(quantity)}
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="tap-target [--tap-h:36px] [--tap-w:36px]"
                          aria-label={`Increase quantity of ${line.productName}`}
                          disabled={roundStock(quantity + line.quantityStep) > 99}
                          onClick={() => setGuestCartQuantity(line.shopProductId, roundStock(quantity + line.quantityStep))}
                        >
                          +
                        </Button>
                        <Button size="sm" variant="ghost" className="ml-2" onClick={() => setGuestCartQuantity(line.shopProductId, 0)}>
                          Remove
                        </Button>
                      </div>
                    </div>
                    <Money paise={line.lineTotalPaise} className="text-sm font-bold" />
                  </li>
                );
              })}
            </ul>
            <dl className="mt-3 space-y-1 border-t border-cream-200 pt-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-600">Items</dt>
                <dd>
                  <Money paise={group.subtotalPaise} />
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-600">Delivery</dt>
                <dd>{group.deliveryFeePaise > 0 ? <Money paise={group.deliveryFeePaise} /> : "Free"}</dd>
              </div>
            </dl>
          </Card>
        ))
      )}

      <Card className="sticky bottom-20 p-4 sm:bottom-4" data-testid="guest-cart-summary">
        <div className="flex items-center justify-between text-base font-bold">
          <span>Total</span>
          {data ? <Money paise={data.grandTotalPaise} className={stale ? "opacity-60" : undefined} /> : <span>…</span>}
        </div>
        {data?.hasUnavailableItems ? (
          <p className="mt-1 text-xs text-amber-800">Items that are not available now are left out of the total.</p>
        ) : null}
        <Button
          className="mt-3 h-12 w-full text-base font-bold"
          onClick={() => {
            returnToCartAfterSignIn();
            router.push("/signin");
          }}
          disabled={!data || data.groups.length === 0}
          data-testid="guest-cart-place-order"
        >
          Sign in to place order
        </Button>
        <p className="mt-2 text-center text-xs text-ink-600">
          Your cart stays in this browser. After signing in you choose the address and pay — nothing is charged yet.
        </p>
      </Card>
    </div>
  );
}
