import Link from "next/link";
import clsx from "clsx";

import { Icon } from "@/components/board/icons";
import { CountBadge, TONE_BLOCK, TONE_ICON } from "@/components/board/tiles";
import { LANG_TAG, tr, type Lang } from "@/lib/board/i18n";
import { ACCOUNTS_TEXT, ACCOUNTS_TILES } from "@/lib/accounts/menu";
import { formatPaiseCompact } from "@/lib/money";
import type { AccountsOverview } from "@/server/accounts/overview";

/**
 * Inventory & Accounting home (Theme 1 Tile Board): four headline figures,
 * then every function as a tile — two columns on a phone, four on a wide
 * screen, all on one screen. Server component: plain links.
 */
export function AccountsBoard({ lang, shopName, overview, shopQuery = "", features = [] }: { lang: Lang; shopName: string; overview: AccountsOverview; shopQuery?: string; features?: readonly string[] }) {
  const facts: { key: string; label: string; value: string | null; href: string; tone: string }[] = [
    { key: "gst", label: tr(ACCOUNTS_TEXT.gstPayable, lang), value: overview.gstPayablePaise != null ? formatPaiseCompact(overview.gstPayablePaise) : null, href: "/shop/accounts/gst", tone: "text-violet-800" },
    { key: "stock", label: tr(ACCOUNTS_TEXT.stockValue, lang), value: overview.stockValuePaise != null ? formatPaiseCompact(overview.stockValuePaise) : null, href: "/shop/accounts/stock", tone: "text-teal-800" },
    { key: "owe", label: tr(ACCOUNTS_TEXT.youOwe, lang), value: overview.payablesPaise != null ? formatPaiseCompact(overview.payablesPaise) : null, href: "/shop/accounts/parties", tone: "text-green-800" },
    { key: "due", label: tr(ACCOUNTS_TEXT.nextDue, lang), value: overview.nextDue ? `${overview.nextDue.returnType === "GSTR3B" ? "3B" : overview.nextDue.returnType === "GSTR1" ? "R1" : "PMT"} · ${overview.nextDue.dueDate.slice(8, 10)}/${overview.nextDue.dueDate.slice(5, 7)}` : null, href: "/shop/accounts/gst", tone: "text-kesari-800" },
  ];
  return (
    <div data-accounts-board="" lang={LANG_TAG[lang]} className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-bold text-ink-900 sm:text-2xl">{tr(ACCOUNTS_TEXT.title, lang)}</h1>
        <span className="truncate text-sm text-ink-600">{shopName}</span>
      </div>
      <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" data-testid="accounts-facts">
        {facts.map((f) => (
          <li key={f.key}>
            <Link href={`${f.href}${shopQuery}`} className="flex min-h-14 flex-col justify-center rounded-xl border border-[var(--gk-line)] bg-white px-3 py-1.5 hover:bg-kesari-50">
              <span className="text-xs font-semibold text-ink-600">{f.label}</span>
              <span className={clsx("text-lg font-bold tabular-nums", f.tone)}>{f.value ?? "—"}</span>
            </Link>
          </li>
        ))}
      </ul>
      <nav aria-label={tr(ACCOUNTS_TEXT.title, lang)} className="min-h-0 flex-1">
        <ul className="grid h-full grid-cols-2 gap-1.5 [grid-auto-rows:minmax(4.25rem,1fr)] sm:grid-cols-3 lg:grid-cols-4 lg:gap-2.5">
          {ACCOUNTS_TILES.filter((tile) => !tile.feature || features.includes(tile.feature)).map((tile) => (
            <li key={tile.key} className="min-w-0">
              <Link
                href={`${tile.href}${shopQuery ? (tile.href.includes("?") ? `&${shopQuery.slice(1)}` : shopQuery) : ""}`}
                data-testid="accounts-tile"
                data-key={tile.key}
                className={clsx("flex h-full min-w-0 items-center gap-2 rounded-2xl p-2.5 hover:brightness-95", TONE_BLOCK[tile.tone])}
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/80">
                  <Icon name={tile.icon} size={22} className={TONE_ICON[tile.tone]} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 block text-[0.9375rem] font-bold leading-tight">{tr(tile.label, lang)}</span>
                  <span className="line-clamp-1 block text-xs text-ink-700">{tr(tile.hint, lang)}</span>
                </span>
                <CountBadge value={tile.count ? overview.counts[tile.count] : undefined} tone={tile.urgent ? "alert" : "accent"} />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="text-xs text-ink-600">{tr(ACCOUNTS_TEXT.caNote, lang)}</p>
    </div>
  );
}
