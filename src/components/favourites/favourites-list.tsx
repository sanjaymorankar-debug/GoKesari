"use client";

/**
 * The /favourites list (docs/search-brand-barcode-favourites-2026-11): each saved product with the
 * lowest price (near the customer when they have a location), "Add to cart" for the shop offering it,
 * and "Remove". Signed in, the server renders the list; a guest's list is read from this browser and
 * priced through /api/favourites/details. Hearts a guest left here are merged into the account on the
 * first signed-in visit, then the list is reloaded.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { SafeImage } from "@/components/safe-image";
import { Button, Card, EmptyState, LinkButton, Money } from "@/components/ui";
import { tr, type Lang } from "@/lib/board/i18n";
import { BBF } from "@/lib/brand-barcode-favourites-i18n";
import { ensureFavouritesLoaded, readLocalFavourites, setFavourite } from "@/lib/favourites-client";
import type { FavouriteView } from "@/server/services/favourites";

export function FavouritesList({ lang, signedIn, initialItems }: { lang: Lang; signedIn: boolean; initialItems: FavouriteView[] | null }) {
  const router = useRouter();
  const [items, setItems] = useState<FavouriteView[] | null>(initialItems);

  useEffect(() => {
    if (signedIn) {
      // The sign-in merge: a guest's hearts in this browser join the account, then the page reloads.
      if (readLocalFavourites().length > 0) void ensureFavouritesLoaded(true).then(() => router.refresh());
      return;
    }
    const ids = readLocalFavourites();
    const controller = new AbortController();
    (ids.length === 0
      ? Promise.resolve({ items: [] })
      : fetch(`/api/favourites/details?ids=${ids.join(",")}`, { signal: controller.signal }).then((r) => (r.ok ? r.json() : { items: [] })))
      .then((d: { items?: FavouriteView[] }) => setItems(d.items ?? []))
      .catch(() => setItems((current) => current ?? []));
    return () => controller.abort();
  }, [signedIn, router]);

  // Server-rendered lists follow a refresh.
  const [rendered, setRendered] = useState(initialItems);
  if (signedIn && rendered !== initialItems) {
    setRendered(initialItems);
    setItems(initialItems);
  }

  if (items === null) return <p className="py-6 text-sm text-ink-600" role="status">…</p>;
  if (items.length === 0) {
    return (
      <EmptyState
        title={tr(BBF.favouritesEmptyTitle, lang)}
        description={tr(BBF.favouritesEmptyText, lang)}
        action={<LinkButton href="/categories">{tr(BBF.browse, lang)}</LinkButton>}
        testId="favourites-empty"
      />
    );
  }
  return (
    <>
      {!signedIn ? <p className="mb-3 text-sm text-ink-600" data-testid="favourites-guest-note">{tr(BBF.guestNote, lang)}</p> : null}
      <Card className="divide-y divide-cream-200" data-testid="favourites-list">
        {items.map((item) => (
          <FavouriteRow
            key={item.productId}
            item={item}
            lang={lang}
            signedIn={signedIn}
            onRemoved={() => setItems((list) => (list ?? []).filter((i) => i.productId !== item.productId))}
          />
        ))}
      </Card>
    </>
  );
}

function FavouriteRow({ item, lang, signedIn, onRemoved }: { item: FavouriteView; lang: Lang; signedIn: boolean; onRemoved: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const best = item.best;

  async function addToCart() {
    if (!best) return;
    if (!signedIn) {
      router.push("/signin");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopProductId: best.shopProductId, quantity: 1 }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setMessage({ tone: "ok", text: tr(BBF.added, lang) });
        router.refresh();
      } else {
        setMessage({ tone: "error", text: data?.error?.message ?? "Could not add to cart." });
      }
    } catch {
      setMessage({ tone: "error", text: "Could not add to cart." });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    await ensureFavouritesLoaded(signedIn);
    const done = await setFavourite(item.productId, false, signedIn);
    setBusy(false);
    if (done) onRemoved();
    else setMessage({ tone: "error", text: "Could not remove it. Try again." });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 p-3 sm:p-4" data-testid="favourite-row" data-product-id={item.productId}>
      <SafeImage src={item.imageUrl} size="thumb" alt={item.name} className="h-16 w-16 shrink-0 rounded-lg bg-cream-100 object-cover" />
      <div className="min-w-0 flex-1 text-sm">
        {item.gone || !best ? (
          <p className="font-semibold text-ink-900">{item.name}</p>
        ) : (
          <Link href={`/products/${item.productId}`} className="font-semibold text-ink-900 hover:text-kesari-700">
            {item.name}
          </Link>
        )}
        <p className="text-xs text-ink-600">
          {[item.brandName, item.packSize].filter(Boolean).join(" · ")}
          {item.mrpPaise != null ? (
            <>
              {" · "}
              {tr(BBF.mrp, lang)} <Money paise={item.mrpPaise} />
            </>
          ) : null}
        </p>
        <p className="mt-0.5 text-xs text-ink-800" data-testid="favourite-price">
          {item.gone ? (
            tr(BBF.goneText, lang)
          ) : !best ? (
            tr(item.nearby ? BBF.notNearYou : BBF.notSold, lang)
          ) : best.onlinePricePaise != null ? (
            <>
              <span className="font-semibold">{tr(item.nearby ? BBF.lowestNearYou : BBF.lowestPrice, lang)}: </span>
              <Money paise={best.onlinePricePaise} className="font-bold" /> · {best.shopName}
              {best.shopCount > 1 ? ` · ${best.shopCount} ${tr(item.nearby ? BBF.shopsNearYou : BBF.shops, lang)}` : ""}
              {!best.buyable ? ` · ${tr(BBF.outOfStock, lang)}` : ""}
            </>
          ) : (
            <>
              {tr(BBF.inShopOnly, lang)} · {best.shopName}
            </>
          )}
        </p>
        {message ? (
          <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "mt-1 text-xs text-red-700" : "mt-1 text-xs text-emerald-700"}>
            {message.text}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {best?.buyable ? (
          <Button type="button" size="sm" disabled={busy} onClick={addToCart} data-testid="favourite-add-to-cart">
            {tr(BBF.addToCart, lang)}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={remove} data-testid="favourite-remove">
          {tr(BBF.remove, lang)}
        </Button>
      </div>
    </div>
  );
}
