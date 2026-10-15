import clsx from "clsx";

import { tr, type Lang } from "@/lib/board/i18n";
import { SELLER_TEXT } from "@/lib/seller/nav";
import { setActiveShopAction } from "@/server/active-shop-action";

interface Props {
  lang: Lang;
  /** The shop Seller Central is showing. */
  current: { id: string; name: string };
  /** All of the owner's shops (shown only when there is more than one). */
  shops: { id: string; name: string }[];
  className?: string;
}

/**
 * The shop name in the Seller Central top bar, as a menu of the owner's
 * shops when they have more than one. Choosing a shop remembers it and
 * re-renders the page for that shop. Works before JavaScript loads (a
 * <details> menu of form buttons).
 */
export function ShopSwitcher({ lang, current, shops, className }: Props) {
  return (
    <details className={clsx("group relative min-w-0", className)} data-testid="shop-switcher">
      <summary
        className="flex min-h-11 min-w-0 cursor-pointer list-none items-center gap-1 rounded-lg px-1 font-semibold hover:bg-white/10 [&::-webkit-details-marker]:hidden"
        aria-label={`${tr(SELLER_TEXT.switchShop, lang)}: ${current.name}`}
      >
        <span className="truncate">{current.name}</span>
        <svg viewBox="0 0 20 20" width={16} height={16} aria-hidden className="shrink-0 transition-transform group-open:rotate-180">
          <path d="M5 7.5 10 12.5 15 7.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <form
        action={setActiveShopAction}
        className="absolute left-0 top-full z-50 mt-1 w-72 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-ink-900 shadow-lg"
      >
        <p className="px-3 pb-1 pt-2 text-xs font-bold uppercase tracking-wider text-slate-500">{tr(SELLER_TEXT.yourShops, lang)}</p>
        {shops.map((s) => (
          <button
            key={s.id}
            type="submit"
            name="shopId"
            value={s.id}
            aria-current={s.id === current.id ? "true" : undefined}
            className={clsx(
              "flex min-h-11 w-full items-center px-3 text-left text-sm",
              s.id === current.id ? "bg-kesari-50 font-bold text-kesari-800" : "hover:bg-slate-50",
            )}
            data-testid="shop-switcher-option"
          >
            <span className="truncate">{s.name}</span>
          </button>
        ))}
      </form>
    </details>
  );
}
