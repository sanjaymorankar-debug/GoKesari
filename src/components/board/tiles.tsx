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
 * Contrast (WCAG AA, 4.5:1 for text): white on kesari-700 5.2:1, white on
 * red-700 6.5:1, tone-800 text on tone-100 and ink-900 on cream all above 7:1.
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

export type BadgeTone = "alert" | "accent" | "soft";

const BADGE: Record<BadgeTone, string> = {
  alert: "bg-red-700 text-white",
  accent: "bg-kesari-700 text-white",
  soft: "bg-kesari-100 text-ink-900",
};

/**
 * A live count. Renders nothing when the figure was not read (or is zero),
 * so a failed query never shows a wrong number.
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
        "inline-grid h-[1.25rem] min-w-[1.25rem] shrink-0 place-items-center rounded-full px-1 text-[0.6875rem] font-bold tabular-nums leading-none lg:h-[1.375rem] lg:min-w-[1.375rem] lg:px-1.5 lg:text-xs",
        BADGE[tone],
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

/** One submenu chip. */
export function Chip({
  item,
  lang,
  counts,
  ticks,
  signedIn = true,
  variant = "row",
  tone,
  phoneCounts = "all",
}: {
  item: Resolved<BoardItem>;
  lang: Lang;
  counts: Counts;
  ticks?: Partial<Record<TickKey, boolean>>;
  signedIn?: boolean;
  /** "row": full-width line in a tile; "pill": compact, sits in a wrapping row. */
  variant?: "row" | "pill";
  tone?: Tone;
  /** "urgent": on phones only red (act-now) counts show on chips; the tile header carries the total. */
  phoneCounts?: "all" | "urgent";
}) {
  const value = item.count ? counts[item.count] : undefined;
  return (
    <Link
      href={entryHref(item, signedIn)}
      data-testid="board-chip"
      data-key={item.key}
      className={clsx(
        "flex min-w-0 items-center gap-[var(--chip-gap-x,0.375rem)] rounded-xl bg-[#fff4e8] font-semibold text-ink-900 transition-colors hover:bg-kesari-100",
        variant === "row"
          ? "h-[var(--chip-h,2rem)] px-[var(--chip-px,0.5rem)] text-[length:var(--chip-text,0.875rem)] lg:h-9 lg:px-3 lg:text-sm"
          : "h-9 shrink-0 px-3 text-sm",
      )}
    >
      {item.icon ? <Icon name={item.icon} size={16} className={clsx("h-[var(--chip-icon,1rem)] w-[var(--chip-icon,1rem)] shrink-0 lg:h-4 lg:w-4", tone ? TONE_ICON[tone] : "text-kesari-700")} /> : null}
      {item.short?.[lang] ? (
        <>
          <span className="min-w-0 flex-1 truncate leading-tight lg:hidden">{item.short[lang]}</span>
          <span className="min-w-0 flex-1 truncate leading-tight max-lg:hidden">{tr(item.label, lang)}</span>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate leading-tight">{tr(item.label, lang)}</span>
      )}
      <CountBadge value={value} tone={item.urgent ? "alert" : "soft"} className={phoneCounts === "urgent" && !item.urgent ? "max-lg:hidden" : undefined} />
      {item.tick ? <VerifiedTick on={ticks?.[item.tick]} lang={lang} /> : null}
    </Link>
  );
}

/**
 * A menu tile: icon chip and live figure on top, the title, then its
 * submenus — a list on phones, a wrapping row of chips on wide screens.
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
  phoneCounts = "all",
  countWord,
  headlineOnPhone = true,
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
  phoneCounts?: "all" | "urgent";
  /** Wide screens: "4 active" under the title; without it the figure shows as a badge. */
  countWord?: Text;
  /** False when the headline is too long for a phone tile (it then shows on wide screens only). */
  headlineOnPhone?: boolean;
}) {
  const value = menu.count ? counts[menu.count] : undefined;
  return (
    <section
      aria-labelledby={`tile-${menu.key}`}
      data-testid="board-tile"
      data-key={menu.key}
      className={clsx(
        "flex min-w-0 flex-col rounded-2xl border border-[#f6dcc4] bg-white p-[var(--tile-pad,0.5rem)] lg:border-l-4 lg:p-4",
        TONE_BAR[menu.tone],
        className,
      )}
    >
      <Link href={entryHref(menu, signedIn)} className="group mb-1 block rounded-lg lg:mb-3 lg:flex lg:items-center lg:gap-3">
        <span className="flex items-start justify-between gap-1">
          <span className={clsx("grid h-8 w-8 shrink-0 place-items-center rounded-xl lg:h-11 lg:w-11", TONE_CHIP[menu.tone])}>
            <Icon name={menu.icon ?? "store"} size={18} className="lg:h-6 lg:w-6" />
          </span>
          <span className="lg:hidden">
            {headline && headlineOnPhone ? (
              <span className="text-xs font-semibold tabular-nums text-ink-700">{headline}</span>
            ) : headline ? null : (
              <CountBadge value={value} tone={menu.urgent ? "alert" : "accent"} />
            )}
          </span>
        </span>
        <span className="block min-w-0">
          <span id={`tile-${menu.key}`} className="mt-0.5 block truncate text-[length:var(--tile-title,1rem)] font-bold leading-tight text-ink-900 group-hover:underline lg:mt-0 lg:text-lg">
            {tr(menu.label, lang)}
          </span>
          <span className="hidden text-sm font-medium text-ink-600 lg:block">
            {headline ??
              (countWord ? (
                value != null && value > 0 ? `${formatCount(value)} ${tr(countWord, lang)}` : "\u00a0"
              ) : (
                <CountBadge value={value} tone={menu.urgent ? "alert" : "accent"} />
              ))}
          </span>
        </span>
      </Link>
      <ul className="flex flex-col gap-[var(--chip-gap,0.25rem)] lg:flex-row lg:flex-wrap lg:gap-2">
        {menu.items.map((item) => (
          <li key={item.key} className="min-w-0">
            <Chip item={item} lang={lang} counts={counts} ticks={ticks} signedIn={signedIn} tone={menu.tone} phoneCounts={phoneCounts} />
          </li>
        ))}
      </ul>
      {footer ? (
        <p className="mt-auto hidden items-center gap-2 truncate border-t border-dashed border-cream-200 pt-3 text-sm text-ink-600 lg:flex">
          <Icon name={footer.icon} size={16} className={TONE_ICON[menu.tone]} />
          <span className="truncate">{footer.text}</span>
        </p>
      ) : null}
    </section>
  );
}

/** The "Do now" strip on the shop owner's and admin's boards. */
export function DoNowStrip({ items, lang, counts }: { items: Resolved<BoardItem>[]; lang: Lang; counts: Counts }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label={tr(UI.doNow, lang)} className="flex items-stretch gap-2" data-testid="do-now">
      <span className="flex w-10 shrink-0 items-center gap-0.5 text-[0.6875rem] font-bold leading-tight text-kesari-700 lg:w-14 lg:text-xs">
        <Icon name="zap" size={18} className="shrink-0" />
        <span>{tr(UI.doNow, lang)}</span>
      </span>
      <ul className="grid min-w-0 flex-1 gap-1.5 lg:gap-2" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((item) => (
          <li key={item.key} className="min-w-0">
            <Link
              href={item.href}
              data-testid="board-chip"
              data-key={`do-${item.key}`}
              className="flex h-10 items-center gap-1 rounded-xl border-2 border-kesari-600 bg-white px-1.5 text-[0.8125rem] font-bold leading-[1.1] text-ink-900 hover:bg-kesari-50 lg:h-11 lg:gap-1.5 lg:px-2 lg:text-sm"
            >
              <CountBadge value={counts[item.count!]} tone={item.urgent ? "alert" : "accent"} />
              <span className="min-w-0 line-clamp-2">{tr(item.label, lang)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A banner with an icon, two lines and one action (order on its way, tomorrow's delivery, operator alerts). */
export function Banner({
  icon,
  iconClass,
  title,
  detail,
  action,
  href,
  testId,
}: {
  icon: IconName;
  iconClass: string;
  title: ReactNode;
  detail?: ReactNode;
  action: string;
  href: string;
  testId: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-2xl border border-[#f6dcc4] bg-white p-2 pr-2" data-testid={testId}>
      <span className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-full text-white", iconClass)}>
        <Icon name={icon} size={18} />
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-sm font-bold text-ink-900">{title}</span>
        {detail ? <span className="block truncate text-xs text-ink-600">{detail}</span> : null}
      </span>
      <Link
        href={href}
        data-testid="board-chip"
        data-key={`${testId}-action`}
        className="shrink-0 rounded-xl bg-kesari-700 px-3 py-2 text-sm font-bold text-white hover:bg-kesari-800"
      >
        {action}
      </Link>
    </div>
  );
}
