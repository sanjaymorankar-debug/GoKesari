import Link from "next/link";
import clsx from "clsx";

import { formatCount } from "@/lib/board/format";
import { tr, UI, type Lang } from "@/lib/board/i18n";

/**
 * Tabs over a list (New / Packing / Ready / Out…): the submenus a board tile
 * shows, each a 44 px link with its live count, wrapping instead of
 * scrolling sideways. The board badge and the tab count the same records.
 */
export function ListTabs({
  tabs,
  active,
  label,
}: {
  tabs: { key: string; label: string; href: string; count?: number; urgent?: boolean }[];
  active: string;
  label: string;
}) {
  return (
    <nav aria-label={label} className="mb-4 flex flex-wrap gap-2" data-testid="list-tabs">
      {tabs.map((t) => {
        const on = t.key === active;
        const count = formatCount(t.count);
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={on ? "page" : undefined}
            data-key={t.key}
            className={clsx(
              "flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-bold",
              on ? "bg-kesari-700 text-white" : "border border-[var(--gk-line)] bg-white text-ink-900 hover:bg-kesari-50",
            )}
          >
            {t.label}
            {count ? (
              <span
                className={clsx(
                  "grid h-[1.375rem] min-w-[1.375rem] place-items-center rounded-full px-1.5 text-xs tabular-nums",
                  on ? "bg-white text-kesari-800" : t.urgent ? "bg-red-700 text-white" : "bg-kesari-100 text-ink-900",
                )}
              >
                {count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** Page through a list instead of scrolling a long page: "Page 2 of 5" with Previous / Next. */
export function Pager({ lang, page, pageCount, hrefFor }: { lang: Lang; page: number; pageCount: number; hrefFor: (page: number) => string }) {
  if (pageCount <= 1) return null;
  const btn = "flex h-11 items-center rounded-xl border border-[var(--gk-line)] bg-white px-4 text-sm font-bold text-ink-900 hover:bg-kesari-50";
  return (
    <nav aria-label={tr(UI.page, lang)} className="mt-4 flex items-center justify-between gap-2" data-testid="pager">
      {page > 1 ? (
        <Link href={hrefFor(page - 1)} className={btn} rel="prev">
          ← {tr(UI.previous, lang)}
        </Link>
      ) : (
        <span />
      )}
      <span className="text-sm font-semibold text-ink-700">
        {tr(UI.page, lang)} {page} {tr(UI.of, lang)} {pageCount}
      </span>
      {page < pageCount ? (
        <Link href={hrefFor(page + 1)} className={btn} rel="next">
          {tr(UI.nextPage, lang)} →
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

/** One page of a list (1-based); a page number out of range shows the nearest page. */
export function paginate<T>(items: readonly T[], page: unknown, size: number): { rows: T[]; page: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const n = Math.min(pageCount, Math.max(1, Math.floor(Number(Array.isArray(page) ? page[0] : page) || 1)));
  return { rows: items.slice((n - 1) * size, n * size), page: n, pageCount };
}
