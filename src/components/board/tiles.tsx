import Link from "next/link";
import clsx from "clsx";
import type { ReactNode } from "react";

import { countForReader, formatCount } from "@/lib/board/format";
import { tr, UI, type Lang, type Text } from "@/lib/board/i18n";
import type { Counts, Resolved, ResolvedMenu, BoardItem, Tone, TickKey } from "@/lib/board/menus";

import { Icon, type IconName } from "./icons";

/*
 * Tile Board building blocks (approved design "Theme 1 Tile Board").
 * Server components: plain links, no client JavaScript.
 *
 * Two shapes of the same tile:
 *  - touch screens (below `lg`): the whole tile is one link — at least
 *    48×48 px, usually far more — and its submenus show inside it as labelled
 *    live counts. It opens the place where those submenus are the first
 *    thing on screen (a tabbed page or the tile's menu page).
 *  - wide screens (`lg` and up, mouse and keyboard): the title and every
 *    submenu are separate links ("chips", 40 px tall).
 *
 * Contrast (WCAG AA, 4.5:1 for text): white on kesari-700 5.2:1, white on
 * red-700 6.5:1, tone-800 text on tone-100, ink-700 and ink-900 on cream and
 * white all above 7:1.
 */

/** Icon chip colours per tile tone. */
export const TONE_CHIP: Record<Tone, string> = {
  kesari: "bg-kesari-100 text-kesari-700",
  teal: "bg-teal-100 text-teal-800",
  blue: "bg-blue-100 text-blue-800",
  green: "bg-green-100 text-green-800",
  violet: "bg-violet-100 text-violet-800",
  pink: "bg-pink-100 text-pink-800",
  amber: "bg-amber-100 text-amber-800",
};

/** Left accent of a tile on wide screens, and the shop owner's label block. */
export const TONE_BAR: Record<Tone, string> = {
  kesari: "border-l-kesari-600",
  teal: "border-l-teal-600",
  blue: "border-l-blue-600",
  green: "border-l-green-700",
  violet: "border-l-violet-600",
  pink: "border-l-pink-600",
  amber: "border-l-amber-600",
};

export const TONE_BLOCK: Record<Tone, string> = {
  kesari: "bg-kesari-100 text-ink-900",
  teal: "bg-teal-100 text-ink-900",
  blue: "bg-blue-100 text-ink-900",
  green: "bg-green-100 text-ink-900",
  violet: "bg-violet-100 text-ink-900",
  pink: "bg-pink-100 text-ink-900",
  amber: "bg-amber-100 text-ink-900",
};

export const TONE_ICON: Record<Tone, string> = {
  kesari: "text-kesari-700",
  teal: "text-teal-700",
  blue: "text-blue-700",
  green: "text-green-700",
  violet: "text-violet-700",
  pink: "text-pink-700",
  amber: "text-amber-700",
};

export type BadgeTone = "alert" | "accent" | "soft" | "done";

const BADGE: Record<BadgeTone, string> = {
  alert: "bg-red-700 text-white",
  accent: "bg-kesari-700 text-white",
  soft: "bg-kesari-100 text-ink-900",
  done: "bg-green-100 text-green-800",
};

/**
 * A live count. Renders nothing when the figure was not read (or is zero,
 * unless `showZero`), so a failed query never shows a wrong number.
 */
export function CountBadge({
  value,
  tone = "soft",
  className,
  showZero,
}: {
  value: number | undefined;
  tone?: BadgeTone;
  className?: string;
  showZero?: boolean;
}) {
  const text = formatCount(value, { showZero });
  if (text == null || value == null) return null;
  return (
    <span
      className={clsx(
        "inline-grid h-[1.375rem] min-w-[1.375rem] shrink-0 place-items-center rounded-full px-1.5 text-xs font-bold tabular-nums leading-none",
        BADGE[value === 0 ? "done" : tone],
        className,
      )}
      data-testid="board-count"
    >
      <span aria-hidden>{text}</span>
      <span className="sr-only">({countForReader(value)})</span>
    </span>
  );
}

/** The green tick on a "Verified" chip — shown only when the record is verified. */
export function VerifiedTick({ on, lang }: { on: boolean | undefined; lang: Lang }) {
  if (!on) return null;
  return (
    <span className="inline-grid h-5 w-5 shrink-0 place-items-center rounded-full bg-green-700 text-white" data-testid="verified-tick">
      <Icon name="circle-check" size={14} strokeWidth={2.5} />
      <span className="sr-only">{tr(UI.verified, lang)}</span>
    </span>
  );
}

/** Where an entry goes: its own link, or sign-in for a visitor when it needs an account. */
export function entryHref(item: Pick<BoardItem, "auth"> & { href: string }, signedIn: boolean): string {
  return item.auth && !signedIn ? "/signin" : item.href;
}

/** Label of an entry: the short form where one exists and room is tight. */
function ItemLabel({ item, lang, short }: { item: Resolved<BoardItem>; lang: Lang; short?: boolean }) {
  const s = item.short?.[lang];
  return <>{short && s ? s : tr(item.label, lang)}</>;
}

/** One submenu chip — a link of its own (wide screens). */
export function Chip({
  item,
  lang,
  counts,
  ticks,
  signedIn = true,
  tone,
  extra,
  withIcon = true,
  urgentOnly,
}: {
  item: Resolved<BoardItem>;
  lang: Lang;
  counts: Counts;
  ticks?: Partial<Record<TickKey, boolean>>;
  signedIn?: boolean;
  tone?: Tone;
  /** Text after the label (the shop wallet's live balance). */
  extra?: string | null;
  /** Dense boards (shop owner, admin) leave the submenu icons to the menu pages. */
  withIcon?: boolean;
  /** Show only red (act-now) counts; the tile carries the total. */
  urgentOnly?: boolean;
}) {
  const value = item.count && (!urgentOnly || item.urgent) ? counts[item.count] : undefined;
  return (
    <Link
      href={entryHref(item, signedIn)}
      data-testid="board-chip"
      data-key={item.key}
      className="flex h-9 min-w-0 shrink-0 items-center gap-1.5 rounded-xl bg-[var(--gk-chip)] px-2.5 text-sm font-semibold text-ink-900 transition-colors hover:bg-kesari-100"
    >
      {withIcon && item.icon ? <Icon name={item.icon} size={16} className={clsx("shrink-0", tone ? TONE_ICON[tone] : "text-kesari-700")} /> : null}
      <span className="min-w-0 truncate leading-tight">
        <ItemLabel item={item} lang={lang} />
      </span>
      {extra ? <span className="text-xs font-bold tabular-nums text-ink-700">{extra}</span> : null}
      <CountBadge value={value} tone={item.urgent ? "alert" : "soft"} />
      {item.tick ? <VerifiedTick on={ticks?.[item.tick]} lang={lang} /> : null}
    </Link>
  );
}

/** One submenu shown inside a touch tile: a label and its live count — not a link of its own. */
function Tag({
  item,
  lang,
  counts,
  ticks,
  tone,
  extra,
  urgentOnly,
  inline,
}: {
  item: Resolved<BoardItem>;
  lang: Lang;
  counts: Counts;
  ticks?: Partial<Record<TickKey, boolean>>;
  tone: Tone;
  extra?: string | null;
  /** Show only red (act-now) counts here; the tile carries the total. */
  urgentOnly?: boolean;
  /** Flow beside the other submenus instead of one per line. */
  inline?: boolean;
}) {
  const value = item.count && (!urgentOnly || item.urgent) ? counts[item.count] : undefined;
  return (
    <span className={clsx("flex min-w-0 items-center gap-0.5 leading-[1.15]", inline && "max-w-full")} data-testid="board-tag" data-key={item.key}>
      <span className={clsx("h-1 w-1 shrink-0 rounded-full", item.urgent && value ? "bg-red-700" : "bg-current opacity-60", TONE_ICON[tone])} aria-hidden />
      <span className="min-w-0 truncate">
        <ItemLabel item={item} lang={lang} short />
      </span>
      {extra ? <span className="shrink-0 font-bold tabular-nums">{extra}</span> : null}
      <CountBadge value={value} tone={item.urgent ? "alert" : "soft"} className="!h-[1.125rem] !min-w-[1.125rem] !px-1" />
      {item.tick ? <VerifiedTick on={ticks?.[item.tick]} lang={lang} /> : null}
    </span>
  );
}

/**
 * A menu tile. Touch screens: one link holding the icon, the title, the
 * live figure and every submenu as a labelled count. Wide screens: the title
 * links to the tile's page or menu page, and each submenu is its own chip,
 * followed by "More" when the tile has more functions on its menu page.
 */
export function Tile({
  menu,
  lang,
  counts,
  ticks,
  signedIn = true,
  headline,
  footer,
  className,
  countWord,
  extras,
  compact,
  layout = "stack",
  tagCounts = "all",
  chipIcons = true,
}: {
  menu: ResolvedMenu;
  lang: Lang;
  counts: Counts;
  ticks?: Partial<Record<TickKey, boolean>>;
  signedIn?: boolean;
  /** Text in place of the count (a wallet balance, an order number). */
  headline?: string | null;
  /** One live line at the foot of the tile, wide screens only. */
  footer?: { icon: IconName; text: string } | null;
  className?: string;
  /** Wide screens: "4 active" under the title; without it the figure shows as a badge. */
  countWord?: Text;
  /** Text after a submenu's label, by submenu key (e.g. a live balance). */
  extras?: Record<string, string | null>;
  /** Touch tiles in a dense grid: icon and title on one row. */
  compact?: boolean;
  /** Touch screens: "row" puts the icon beside a short title and the submenus flowing after it (the shop owner's sixteen tiles). */
  layout?: "stack" | "row";
  /** Touch screens: "urgent" shows only red counts beside submenus (narrow tiles). */
  tagCounts?: "all" | "urgent";
  /** Wide screens: icons on the submenu chips. */
  chipIcons?: boolean;
}) {
  const value = menu.count ? counts[menu.count] : undefined;
  const title = tr(menu.label, lang);
  const shortTitle = menu.short?.[lang] ?? title;
  const href = entryHref(menu, signedIn);
  return (
    <section
      aria-label={title}
      data-testid="board-tile"
      data-key={menu.key}
      className={clsx("flex min-h-0 min-w-0 flex-col rounded-2xl border border-[var(--gk-line)] bg-white lg:border-l-4 lg:p-4", TONE_BAR[menu.tone], className)}
    >
      {/* Touch screens: the whole tile is one target. */}
      {layout === "row" ? (
        <Link
          href={href}
          data-testid="board-tile-link"
          data-key={menu.key}
          className="flex h-full min-h-12 min-w-0 items-start gap-1.5 overflow-hidden rounded-2xl px-1.5 py-1.5 hover:bg-kesari-50 lg:hidden"
        >
          <span className={clsx("grid h-7 w-7 shrink-0 place-items-center rounded-lg", TONE_CHIP[menu.tone])}>
            <Icon name={menu.icon ?? "store"} size={16} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-[length:var(--gk-tile-title,0.9375rem)] font-bold leading-tight text-ink-900">{shortTitle}</span>
              {headline ? (
                <span className="shrink-0 text-xs font-bold tabular-nums text-ink-900">{headline}</span>
              ) : (
                <CountBadge value={value} tone={menu.urgent ? "alert" : "accent"} />
              )}
            </span>
            <span className="flex min-w-0 flex-wrap content-start gap-x-1.5 gap-y-0.5 overflow-hidden text-[length:var(--gk-tag-text,0.8125rem)] font-medium text-ink-700">
              {menu.items.map((item) => (
                <Tag key={item.key} item={item} lang={lang} counts={counts} ticks={ticks} tone={menu.tone} extra={extras?.[item.key]} urgentOnly={tagCounts === "urgent"} inline />
              ))}
              {menu.more.length > 0 ? <span className="text-kesari-800">+{menu.more.length}</span> : null}
            </span>
          </span>
        </Link>
      ) : (
        <Link
          href={href}
          data-testid="board-tile-link"
          data-key={menu.key}
          className="flex h-full min-h-12 min-w-0 flex-col gap-1 overflow-hidden rounded-2xl p-2 hover:bg-kesari-50 lg:hidden"
        >
          <span className={clsx("flex min-w-0 gap-1.5", compact ? "items-center" : "items-start justify-between")}>
            <span className={clsx("grid h-8 w-8 shrink-0 place-items-center rounded-xl", TONE_CHIP[menu.tone])}>
              <Icon name={menu.icon ?? "store"} size={18} />
            </span>
            {compact ? (
              <span className="line-clamp-2 min-w-0 flex-1 text-[length:var(--gk-tile-title,0.9375rem)] font-bold leading-tight text-ink-900">{shortTitle}</span>
            ) : null}
            {headline ? (
              <span className="truncate text-sm font-bold tabular-nums text-ink-900 max-[359px]:text-xs">{headline}</span>
            ) : (
              <span className="flex shrink-0 items-center gap-1">
                <CountBadge value={value} tone={menu.urgent ? "alert" : "accent"} />
                {menu.more.length > 0 ? (
                  <span className="text-xs font-bold text-kesari-800" aria-label={`${menu.more.length} ${tr(UI.more, lang)}`}>
                    +{menu.more.length}
                  </span>
                ) : null}
              </span>
            )}
          </span>
          {compact ? null : (
            <span className="line-clamp-2 text-[length:var(--gk-tile-title,0.9375rem)] font-bold leading-tight text-ink-900">{shortTitle}</span>
          )}
          <span className="flex min-h-0 min-w-0 flex-col gap-[var(--gk-tag-gap,0.25rem)] overflow-hidden text-[length:var(--gk-tag-text,0.875rem)] font-medium text-ink-700">
            {menu.items.map((item) => (
              <Tag key={item.key} item={item} lang={lang} counts={counts} ticks={ticks} tone={menu.tone} extra={extras?.[item.key]} urgentOnly={tagCounts === "urgent"} />
            ))}
          </span>
        </Link>
      )}

      {/* Wide screens: title and each submenu are separate links. */}
      <Link href={href} className="group mb-2 hidden items-center gap-3 rounded-lg max-lg:hidden lg:flex">
        <span className={clsx("grid h-11 w-11 shrink-0 place-items-center rounded-xl", TONE_CHIP[menu.tone])}>
          <Icon name={menu.icon ?? "store"} size={24} />
        </span>
        <span className="block min-w-0">
          <span className="block truncate text-lg font-bold leading-tight text-ink-900 group-hover:underline">{title}</span>
          <span className="block text-sm font-medium text-ink-600">
            {headline ??
              (countWord ? (
                value != null && value > 0 ? `${formatCount(value)} ${tr(countWord, lang)}` : " "
              ) : (
                <CountBadge value={value} tone={menu.urgent ? "alert" : "accent"} />
              ))}
          </span>
        </span>
      </Link>
      <ul className="hidden flex-wrap gap-1.5 max-lg:hidden lg:flex">
        {menu.items.map((item) => (
          <li key={item.key} className="min-w-0">
            <Chip item={item} lang={lang} counts={counts} ticks={ticks} signedIn={signedIn} tone={menu.tone} extra={extras?.[item.key]} withIcon={chipIcons} urgentOnly={tagCounts === "urgent"} />
          </li>
        ))}
        {menu.more.length > 0 ? (
          <li>
            <MoreChip href={href} lang={lang} count={menu.more.length} />
          </li>
        ) : null}
      </ul>
      {footer ? (
        <p className="mt-auto hidden items-center gap-2 truncate border-t border-dashed border-cream-200 pt-3 text-sm text-ink-600 max-lg:hidden lg:flex">
          <Icon name={footer.icon} size={16} className={TONE_ICON[menu.tone]} />
          <span className="truncate">{footer.text}</span>
        </p>
      ) : null}
    </section>
  );
}

/** "More (4)": the rest of a tile's functions, on its menu page. */
export function MoreChip({ href, lang, count }: { href: string; lang: Lang; count: number }) {
  return (
    <Link
      href={href}
      data-testid="board-chip"
      data-key="more"
      className="flex h-9 items-center gap-1 rounded-xl border border-dashed border-kesari-300 px-2.5 text-sm font-semibold text-kesari-800 hover:bg-kesari-50"
    >
      <Icon name="ellipsis" size={16} />
      {tr(UI.more, lang)}
      <span className="tabular-nums text-ink-600">({count})</span>
    </Link>
  );
}

/**
 * The "Do now" strip every role's board opens with: what needs action, each
 * with its live count — zero shows as a green 0, so "nothing waiting" is a
 * visible answer rather than a missing badge.
 */
export function DoNowStrip({ items, lang, counts }: { items: Resolved<BoardItem>[]; lang: Lang; counts: Counts }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label={tr(UI.doNow, lang)} className="flex items-stretch gap-1.5 lg:gap-2" data-testid="do-now">
      <span className="flex w-10 shrink-0 flex-col items-center justify-center text-center text-xs font-bold leading-tight text-kesari-800 lg:w-14">
        <Icon name="zap" size={18} className="shrink-0" />
        <span>{tr(UI.doNow, lang)}</span>
      </span>
      <ul className={clsx("grid min-w-0 flex-1 gap-1.5 lg:gap-2", items.length > 3 ? "grid-cols-2 lg:grid-cols-4" : items.length === 3 ? "grid-cols-3" : "grid-cols-2")}>
        {items.map((item) => {
          const value = item.count ? counts[item.count] : undefined;
          const waiting = (value ?? 0) > 0;
          return (
            <li key={item.key} className="min-w-0">
              <Link
                href={item.href}
                data-testid="board-chip"
                data-key={`do-${item.key}`}
                className={clsx(
                  "flex h-12 min-w-0 items-center gap-1 rounded-xl border-2 px-1.5 text-[0.8125rem] font-bold leading-[1.1] text-ink-900 lg:gap-1.5 lg:px-2.5 lg:text-sm",
                  waiting ? "border-kesari-600 bg-white hover:bg-kesari-50" : "border-[var(--gk-line)] bg-white/70 hover:bg-white",
                )}
              >
                {item.icon ? <Icon name={item.icon} size={18} className="hidden shrink-0 text-kesari-700 min-[400px]:block" /> : null}
                <span className="line-clamp-2 min-w-0 flex-1">{tr(item.label, lang)}</span>
                <CountBadge value={value} tone={item.urgent ? "alert" : "accent"} showZero />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** A banner with an icon, two lines and one action (order on its way, tomorrow's delivery, alerts). */
export function Banner({
  icon,
  iconClass,
  title,
  detail,
  action,
  href,
  testId,
  tone = "plain",
}: {
  icon: IconName;
  iconClass: string;
  title: ReactNode;
  detail?: ReactNode;
  action: string;
  href: string;
  testId: string;
  /** "warning" / "danger": the shop owner's account alerts. */
  tone?: "plain" | "warning" | "danger";
}) {
  return (
    <div
      className={clsx(
        "flex min-w-0 items-center gap-2.5 rounded-2xl border p-1.5 pl-2",
        tone === "danger" ? "border-red-300 bg-red-50" : tone === "warning" ? "border-amber-300 bg-amber-50" : "border-[var(--gk-line)] bg-white",
      )}
      data-testid={testId}
      role={tone === "plain" ? undefined : "status"}
    >
      <span className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-full text-white", iconClass)}>
        <Icon name={icon} size={18} />
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-sm font-bold text-ink-900">{title}</span>
        {detail ? <span className="block truncate text-[0.8125rem] text-ink-700">{detail}</span> : null}
      </span>
      <Link
        href={href}
        data-testid="board-chip"
        data-key={`${testId}-action`}
        className="flex h-12 shrink-0 items-center rounded-xl bg-kesari-700 px-3.5 text-sm font-bold text-white hover:bg-kesari-800"
      >
        {action}
      </Link>
    </div>
  );
}
