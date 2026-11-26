"use client";

/**
 * The heart on a product card and the product page (docs/search-brand-barcode-favourites-2026-11).
 * Rendered only while the flag brand_barcode_favourites_enabled is on. Guests' hearts stay in this
 * browser and move to the account at sign-in (lib/favourites-client).
 */
import clsx from "clsx";
import { useState } from "react";

import { tr, type Lang } from "@/lib/board/i18n";
import { BBF } from "@/lib/brand-barcode-favourites-i18n";
import { toggleFavourite, useFavourites } from "@/lib/favourites-client";

export function FavouriteHeart({
  productId,
  productName,
  signedIn,
  lang = "en",
  size = "sm",
  className,
}: {
  productId: string;
  productName: string;
  signedIn: boolean;
  lang?: Lang;
  size?: "sm" | "md";
  className?: string;
}) {
  const { ids, error } = useFavourites(signedIn);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const saved = ids.has(productId);
  const label = `${tr(saved ? BBF.removeFavourite : BBF.addFavourite, lang)}: ${productName}`;
  const px = size === "md" ? 22 : 18;

  return (
    <span className={clsx("inline-flex flex-col items-end", className)}>
      <button
        type="button"
        aria-pressed={saved}
        aria-label={label}
        title={label}
        disabled={busy}
        data-testid="favourite-heart"
        data-saved={saved ? "true" : "false"}
        onClick={async () => {
          setBusy(true);
          setFailed(!(await toggleFavourite(productId, signedIn)));
          setBusy(false);
        }}
        className={clsx(
          "grid shrink-0 place-items-center rounded-full border bg-white/90 transition-colors",
          size === "md" ? "h-11 w-11" : "h-9 w-9",
          saved ? "border-rose-200 text-rose-600" : "border-cream-200 text-ink-600 hover:text-rose-600",
          busy && "opacity-60",
        )}
      >
        <svg width={px} height={px} viewBox="0 0 24 24" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
        </svg>
      </button>
      {failed && error ? (
        <span role="alert" className="mt-1 max-w-40 text-right text-xs text-red-700">
          {error}
        </span>
      ) : null}
    </span>
  );
}
