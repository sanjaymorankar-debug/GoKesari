import Link from "next/link";
import clsx from "clsx";

import { formatRupees } from "@/lib/board/format";
import { LANG_TAG, tr, UI, type Lang } from "@/lib/board/i18n";
import { SHOP_DO_NOW, SHOP_MENUS, visibleItems, visibleMenus } from "@/lib/board/menus";
import type { UserRole } from "@/server/db/schema";
import type { BoardHeaderData } from "@/server/board-header-data";
import type { ShopBoardData } from "@/server/board-data";

import { BoardHeader } from "./board-header";
import { Icon, type IconName } from "./icons";
import { Banner, Chip, CountBadge, DoNowStrip, MoreChip, TONE_BLOCK, TONE_ICON, Tile } from "./tiles";

/** Something about the shop's account the owner must act on (suspension, wallet, documents…). */
export interface ShopAlert {
  key: string;
  tone: "warning" | "danger";
  icon: IconName;
  title: string;
  detail?: string | null;
  action: string;
  href: string;
}

interface Props {
  lang: Lang;
  user: { name: string | null; email: string; role: UserRole };
  header: BoardHeaderData;
  shop: { name: string; slug: string };
  data: ShopBoardData;
  /** Account alerts, most serious first; at most two show, the rest behind "Today's work". */
  alerts?: ShopAlert[];
}

/**
 * Shop owner home board (`/shop`): account alerts (only when there is one),
 * the "Do now" strip and the sixteen menus. Phones: two columns of tiles,
 * each one large target. Wide screens: two columns of rows — the menu on the
 * left, its submenu chips on the right.
 */
export function ShopBoard({ lang, user, header, shop, data, alerts = [] }: Props) {
  const params = { shopSlug: shop.slug };
  const menus = visibleMenus(SHOP_MENUS, user.role, params, "shop");
  const doNow = visibleItems(SHOP_DO_NOW, user.role, params);
  const ticks = { bankVerified: data.facts.bankVerified, shopVerified: data.facts.shopVerified };
  const walletBalance = formatRupees(data.facts.walletBalancePaise);
  const extras = { balance: walletBalance };

  return (
    <div data-tile-board="shop" lang={LANG_TAG[lang]} className="flex min-h-[100svh] flex-col bg-[var(--gk-bg)] text-ink-900 max-lg:h-[100svh]">
      <BoardHeader
        lang={lang}
        user={user}
        roles={header.roles}
        unreadCount={header.unread}
        extraLinks={header.extraLinks}
        context={{ kind: "staff", roleLine: tr(UI.myShop, lang), title: shop.name }}
      />
      <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-1.5 px-2 py-1.5 sm:px-3 lg:gap-4 lg:px-6 lg:py-4">
        {alerts.length > 0 ? (
          <div className="grid gap-1.5 lg:grid-cols-2 lg:gap-3" data-testid="shop-alerts">
            {alerts.slice(0, 2).map((a) => (
              <Banner
                key={a.key}
                testId={`shop-alert-${a.key}`}
                tone={a.tone}
                icon={a.icon}
                iconClass={a.tone === "danger" ? "bg-red-700" : "bg-amber-700"}
                title={a.title}
                detail={a.detail}
                action={a.action}
                href={a.href}
              />
            ))}
          </div>
        ) : null}

        <DoNowStrip items={doNow} lang={lang} counts={data.counts} />

        {/* Touch screens: sixteen tiles, two columns. */}
        <nav aria-label={tr(UI.board, lang)} className="flex min-h-0 flex-1 flex-col lg:hidden">
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-1 [grid-auto-rows:minmax(0,1fr)]">
            {menus.map((menu) => (
              <Tile key={menu.key} menu={menu} lang={lang} counts={data.counts} ticks={ticks} extras={menu.key === "wallet" ? extras : undefined} layout="row" />
            ))}
          </div>
        </nav>

        {/* Wide screens: two columns of eight rows. */}
        <ul className="hidden flex-1 content-start gap-x-4 gap-y-2 max-lg:hidden lg:grid lg:grid-flow-col lg:grid-cols-2 lg:grid-rows-8" aria-label={tr(UI.board, lang)}>
          {menus.map((menu) => {
            const value = menu.count ? data.counts[menu.count] : undefined;
            return (
              <li
                key={menu.key}
                data-testid="board-tile"
                data-key={menu.key}
                className="flex min-w-0 items-stretch gap-1.5 rounded-2xl border border-[var(--gk-line)] bg-white p-1.5"
              >
                <Link
                  href={menu.href}
                  className={clsx("flex w-[11rem] shrink-0 items-center gap-1.5 rounded-xl px-3 py-1 hover:brightness-95", TONE_BLOCK[menu.tone])}
                >
                  <Icon name={menu.icon ?? "store"} size={20} className={clsx("shrink-0", TONE_ICON[menu.tone])} />
                  <span className="line-clamp-2 min-w-0 flex-1 text-[0.9375rem] font-bold leading-tight">{tr(menu.label, lang)}</span>
                  <CountBadge value={value} tone={menu.urgent ? "alert" : "accent"} />
                </Link>
                <ul className="flex min-w-0 flex-1 flex-wrap content-center items-center gap-1.5">
                  {menu.items.map((item) => (
                    <li key={item.key} className="min-w-0">
                      <Chip lang={lang} item={item} counts={data.counts} ticks={ticks} tone={menu.tone} extra={menu.key === "wallet" && item.key === "balance" ? walletBalance : null} withIcon={false} />
                    </li>
                  ))}
                  {menu.more.length > 0 ? (
                    <li>
                      <MoreChip href={menu.href} lang={lang} count={menu.more.length} />
                    </li>
                  ) : null}
                </ul>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
