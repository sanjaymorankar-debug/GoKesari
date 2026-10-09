import Link from "next/link";

import { formatCount } from "@/lib/board/format";
import { tr, type Lang } from "@/lib/board/i18n";
import { MENUS, visibleMenus, type BoardRole, type Counts, type LinkParams } from "@/lib/board/menus";
import type { UserRole } from "@/server/db/schema";

import { Icon } from "./icons";

/**
 * A board tile's submenus as one row of large links at the top of the page
 * the tile opens — so on a phone, where the tile itself is the target, each
 * submenu is still the second tap. Same words, icons and counts as the board.
 */
export function SubmenuStrip({
  board,
  menuKey,
  role,
  lang,
  counts = {},
  params = {},
  current,
}: {
  board: BoardRole;
  menuKey: string;
  role: UserRole;
  lang: Lang;
  counts?: Counts;
  params?: LinkParams;
  /** The submenu this page is (marked as current). */
  current?: string;
}) {
  const menu = visibleMenus(MENUS[board], role, params).find((m) => m.key === menuKey);
  if (!menu) return null;
  const items = [...menu.items, ...menu.more];
  return (
    <nav aria-label={tr(menu.label, lang)} className="mb-4 flex flex-wrap gap-2" data-testid="submenu-strip">
      {items.map((item) => {
        const count = item.count ? formatCount(counts[item.count]) : null;
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={current === item.key ? "page" : undefined}
            className={
              current === item.key
                ? "flex min-h-11 items-center gap-1.5 rounded-xl bg-kesari-700 px-3.5 text-sm font-bold text-white"
                : "flex min-h-11 items-center gap-1.5 rounded-xl border border-[var(--gk-line)] bg-white px-3.5 text-sm font-semibold text-ink-900 hover:bg-kesari-50"
            }
          >
            {item.icon ? <Icon name={item.icon} size={16} className={current === item.key ? "" : "text-kesari-700"} /> : null}
            {tr(item.label, lang)}
            {count ? <span className="rounded-full bg-kesari-100 px-1.5 text-xs font-bold text-ink-900">{count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
