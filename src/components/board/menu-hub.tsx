import Link from "next/link";
import clsx from "clsx";

import { tr, UI, type Lang } from "@/lib/board/i18n";
import type { Counts, Resolved, ResolvedMenu, BoardItem, TickKey } from "@/lib/board/menus";

import { Icon } from "./icons";
import { CountBadge, TONE_CHIP, VerifiedTick } from "./tiles";

/**
 * A tile's menu page (`/shop/menu/{key}`, `/admin/menu/{key}`): every
 * function of that area as a large tile — what the board shows first, then
 * the rest. Each tile is one target at least 64 px tall, so this page is also
 * the comfortable way in on a phone. Second click from the home screen.
 */
export function MenuHub({
  lang,
  menu,
  counts,
  ticks,
  boardHref,
}: {
  lang: Lang;
  menu: ResolvedMenu;
  counts: Counts;
  ticks?: Partial<Record<TickKey, boolean>>;
  boardHref: string;
}) {
  return (
    <div data-testid="menu-hub" data-key={menu.key} className="mx-auto w-full max-w-5xl">
      <Link
        href={boardHref}
        className="mb-3 inline-flex h-11 items-center gap-1.5 rounded-xl px-2 text-sm font-semibold text-kesari-800 hover:bg-kesari-50"
        data-testid="back-to-board"
      >
        <Icon name="arrow-left" size={18} />
        {tr(UI.backToBoard, lang)}
      </Link>
      <h1 className="mb-4 flex items-center gap-3 text-2xl font-bold text-ink-900">
        <span className={clsx("grid h-11 w-11 shrink-0 place-items-center rounded-xl", TONE_CHIP[menu.tone])}>
          <Icon name={menu.icon ?? "store"} size={24} />
        </span>
        {tr(menu.label, lang)}
      </h1>
      <HubGroup lang={lang} items={menu.items} counts={counts} ticks={ticks} fallbackIcon={menu.icon} title={menu.more.length ? tr(UI.onYourBoard, lang) : null} />
      {menu.more.length > 0 ? (
        <HubGroup lang={lang} items={menu.more} counts={counts} ticks={ticks} fallbackIcon={menu.icon} title={tr(UI.moreHere, lang)} />
      ) : null}
    </div>
  );
}

function HubGroup({
  lang,
  items,
  counts,
  ticks,
  fallbackIcon,
  title,
}: {
  lang: Lang;
  items: Resolved<BoardItem>[];
  counts: Counts;
  ticks?: Partial<Record<TickKey, boolean>>;
  fallbackIcon?: BoardItem["icon"];
  title: string | null;
}) {
  if (items.length === 0) return null;
  return (
    <section className="mb-5">
      {title ? <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-700">{title}</h2> : null}
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 lg:gap-3">
        {items.map((item) => (
          <li key={item.key} className="min-w-0">
            <Link
              href={item.href}
              data-testid="hub-tile"
              data-key={item.key}
              className="flex min-h-16 min-w-0 items-center gap-2.5 rounded-2xl border border-[var(--gk-line)] bg-white p-3 hover:border-kesari-300 hover:bg-kesari-50"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--gk-chip)] text-kesari-700">
                <Icon name={item.icon ?? fallbackIcon ?? "chevron-right"} size={20} />
              </span>
              <span className="min-w-0 flex-1 text-base font-semibold leading-tight text-ink-900">{tr(item.label, lang)}</span>
              <CountBadge value={item.count ? counts[item.count] : undefined} tone={item.urgent ? "alert" : "soft"} />
              {item.tick ? <VerifiedTick on={ticks?.[item.tick]} lang={lang} /> : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
