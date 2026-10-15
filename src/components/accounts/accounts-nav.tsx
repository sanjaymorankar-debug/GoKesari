import Link from "next/link";
import clsx from "clsx";

import { Icon } from "@/components/board/icons";
import { tr, type Lang } from "@/lib/board/i18n";
import { ACCOUNTS_NAV } from "@/lib/accounts/menu";

/**
 * The module's page row (docs/inventory-accounting-2026-10): every page one
 * tap away, scrolls sideways on a phone, current page marked.
 */
export function AccountsNav({ lang, current, shopQuery = "" }: { lang: Lang; current: string; shopQuery?: string }) {
  return (
    <nav aria-label="Inventory & Accounts" className="-mx-2 mb-3 flex gap-1.5 overflow-x-auto px-2 pb-1 [scrollbar-width:none]" data-testid="accounts-nav">
      {ACCOUNTS_NAV.map((item) => (
        <Link
          key={item.key}
          href={`${item.href}${shopQuery}`}
          aria-current={current === item.key ? "page" : undefined}
          className={clsx(
            "flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold",
            current === item.key ? "bg-kesari-700 text-white" : "border border-[var(--gk-line)] bg-white text-ink-900 hover:bg-kesari-50",
          )}
        >
          <Icon name={item.icon} size={16} className={current === item.key ? "" : "text-kesari-700"} />
          {tr(item.label, lang)}
        </Link>
      ))}
    </nav>
  );
}

/** Page title row used by every module page. */
export function AccountsHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div className="min-w-0">
        <h1 className="text-xl font-bold text-ink-900 sm:text-2xl">{title}</h1>
        {subtitle ? <p className="text-sm text-ink-600">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}
