import Link from "next/link";

import { Icon } from "@/components/board/icons";
import { tr, type Lang } from "@/lib/board/i18n";
import { isPermitted, SHOP_TYPE_MODULES } from "@/lib/board/menus";
import type { UserRole } from "@/server/db/schema";

/**
 * Shop types with their own admin page (Puja Samagri, Consultants, Health), shown at the top of the Shop
 * categories page: they are kinds of shop, so they open from here rather than as separate Categories tiles
 * (owner, 21-Nov-2026). Only the pages this role may open are listed; each page checks again.
 */
export function ShopTypeModules({ role, lang = "en" }: { role: UserRole; lang?: Lang }) {
  const items = SHOP_TYPE_MODULES.filter((m) => isPermitted(m, role));
  if (items.length === 0) return null;
  return (
    <section className="mb-6" aria-labelledby="shop-type-modules-title" data-testid="shop-type-modules">
      <h2 id="shop-type-modules-title" className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-700">
        Shop types with their own setup
      </h2>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:gap-3">
        {items.map((item) => (
          <li key={item.key} className="min-w-0">
            <Link
              href={item.href}
              data-testid="shop-type-module"
              data-key={item.key}
              className="flex min-h-16 min-w-0 items-center gap-2.5 rounded-2xl border border-[var(--gk-line)] bg-white p-3 hover:border-kesari-300 hover:bg-kesari-50"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--gk-chip)] text-kesari-700">
                <Icon name={item.icon ?? "store"} size={20} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold leading-tight text-ink-900">{tr(item.label, lang)}</span>
                <span className="mt-0.5 block text-xs leading-snug text-ink-700">{tr(item.note, lang)}</span>
              </span>
              <Icon name="chevron-right" size={18} className="shrink-0 text-ink-700" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
