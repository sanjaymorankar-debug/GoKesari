"use client";

/**
 * docs/guest-checkout-2026-11: "Best shop for this cart" (flags guest_cart_enabled +
 * guest_checkout_enabled). Asks POST /api/cart/recommendation for a nearby shop that delivers here
 * and has every item — cheaper, or able to supply items the cart cannot — and offers to move the
 * lines there. Signed in: the server moves them (and re-checks the suggestion). Guest: the browser
 * cart is changed. Shows nothing when there is no better shop.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Alert, Button, Card, Money } from "@/components/ui";
import { tr, type Lang } from "@/lib/board/i18n";
import { addToGuestCart, setGuestCartQuantity, type GuestCartLine } from "@/lib/guest-cart";
import { GC } from "@/lib/guest-checkout-i18n";
import type { CartRecommendation } from "@/server/guest-checkout/recommendation";

export function CartShopRecommendation({ lang, guestLines, cartKey }: { lang: Lang; guestLines?: GuestCartLine[]; cartKey: string }) {
  const router = useRouter();
  const [rec, setRec] = useState<CartRecommendation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const guest = guestLines !== undefined;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/cart/recommendation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(guest ? { lines: guestLines } : {}),
        });
        if (!response.ok || cancelled) return;
        const body = (await response.json()) as { recommendation: CartRecommendation | null };
        if (!cancelled) setRec(body.recommendation);
      } catch {
        // A suggestion is optional: say nothing if it cannot be worked out.
      }
    })();
    return () => {
      cancelled = true;
    };
    // cartKey captures the lines.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartKey]);

  if (!rec) return null;

  async function move() {
    if (!rec) return;
    setError(null);
    if (guest) {
      for (const m of rec.moves) {
        setGuestCartQuantity(m.fromShopProductId, 0);
        addToGuestCart(m.toShopProductId, m.quantity);
      }
      setRec(null);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/cart/recommendation/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId: rec.shop.shopId }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(body?.error?.message ?? "Could not move the items.");
        return;
      }
      setRec(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4 border-leaf-300 bg-leaf-50 p-4" data-testid="cart-best-shop">
      <p className="text-sm font-bold text-ink-900">{tr(GC.bestShop, lang)}</p>
      <p className="mt-1 text-sm text-ink-800">
        <strong>{rec.shop.shopName}</strong>
        {rec.shop.distanceKm != null ? ` · ${rec.shop.distanceKm.toFixed(1)} km` : ""} has all {rec.shop.total} item{rec.shop.total === 1 ? "" : "s"} for{" "}
        <Money paise={rec.shop.totalPaise} /> with delivery
        {rec.savingsPaise > 0 ? (
          <>
            {" "}
            — <strong>save <Money paise={rec.savingsPaise} /></strong>
          </>
        ) : null}
        {rec.completesCart ? " — including items your cart cannot get now" : ""}.
      </p>
      {rec.moves.some((m) => m.similar) ? <p className="mt-1 text-xs text-ink-600">Some items are a similar product of the same size.</p> : null}
      {error ? (
        <div className="mt-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
      <Button size="sm" className="mt-3" onClick={move} disabled={busy} data-testid="cart-best-shop-move">
        {tr(GC.move, lang)}
      </Button>
    </Card>
  );
}
