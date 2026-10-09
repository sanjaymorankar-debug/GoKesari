import Link from "next/link";
import clsx from "clsx";

import { formatRupees } from "@/lib/board/format";
import { LANG_TAG, tr, UI, type Lang } from "@/lib/board/i18n";
import { SHOP_DO_NOW, SHOP_MENUS, visibleItems, visibleMenus } from "@/lib/board/menus";
import type { UserRole } from "@/server/db/schema";
import type { BoardHeaderData } from "@/server/board-header-data";
import type { ShopBoardData } from "@/server/board-data";

import { BoardHeader } from "./board-header";
import { Icon } from "./icons";
import { Chip, CountBadge, DoNowStrip, TONE_BLOCK, TONE_ICON } from "./tiles";

interface Props {
  lang: Lang;
  user: { name: string | null; email: string; role: UserRole };
  header: BoardHeaderData;
  shop: { name: string; slug: string };
  data: ShopBoardData;
}

/**
 * Shop owner home board (`/shop`): the "Do now" strip, then one row per menu
 * — its label on the left, its submenu chips on the right. One column on
 * phones, two on wide screens; all sixteen rows on the first screen.
 */
export function ShopBoard({ lang, user, header, shop, data }: Props) {
  const params = { shopSlug: shop.slug };
  const menus = visibleMenus(SHOP_MENUS, user.role, params);
  const doNow = visibleItems(SHOP_DO_NOW, user.role, params);
  const ticks = { bankVerified: data.facts.bankVerified, shopVerified: data.facts.shopVerified };
  const walletBalance = formatRupees(data.facts.walletBalancePaise);

  return (
    <div data-tile-board="shop" lang={LANG_TAG[lang]} className="flex min-h-[100svh] flex-col bg-[#fdf4ea] text-ink-900">
      <BoardHeader
        lang={lang}
        user={user}
        roles={header.roles}
        unreadCount={header.unread}
        extraLinks={header.extraLinks}
        context={{ kind: "staff", roleLine: tr(UI.myShop, lang), title: shop.name }}
      />
      <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-1.5 px-2 py-1.5 sm:px-3 lg:gap-4 lg:px-6 lg:py-4">
        <DoNowStrip items={doNow} lang={lang} counts={data.counts} />
        <ul className="grid flex-1 content-start gap-[0.1875rem] lg:grid-flow-col lg:grid-cols-2 lg:grid-rows-8 lg:gap-x-4 lg:gap-y-2" aria-label={tr(UI.board, lang)}>
          {menus.map((menu) => {
            const value = menu.count ? data.counts[menu.count] : undefined;
            return (
              <li
                key={menu.key}
                data-testid="board-tile"
                data-key={menu.key}
                className="flex min-w-0 items-stretch gap-1 rounded-2xl border border-[#f6dcc4] bg-white p-0.5 lg:gap-1.5 lg:p-1.5"
              >
                <Link
                  href={menu.href}
                  className={clsx(
                    "flex min-h-[1.625rem] w-[6.25rem] shrink-0 items-center gap-1 rounded-xl px-1 py-0.5 hover:brightness-95 sm:w-[8.5rem] lg:w-[11rem] lg:gap-1.5 lg:px-3",
                    TONE_BLOCK[menu.tone],
                  )}
                >
                  <Icon name={menu.icon ?? "store"} size={16} className={clsx("shrink-0 lg:h-5 lg:w-5", TONE_ICON[menu.tone])} />
                  <span className="line-clamp-2 min-w-0 flex-1 text-[0.78125rem] font-bold leading-[1.05] lg:text-[0.9375rem] lg:leading-tight">
                    {tr(menu.label, lang)}
                  </span>
                  <CountBadge value={value} tone={menu.urgent ? "alert" : "accent"} />
                </Link>
                <ul className="flex min-w-0 flex-1 flex-wrap content-center items-center gap-[0.1875rem] lg:gap-1.5">
                  {menu.items.map((item) => (
                    <li key={item.key} className="min-w-0">
                      <ShopChip
                        lang={lang}
                        item={item}
                        counts={data.counts}
                        ticks={ticks}
                        balance={menu.key === "wallet" && item.key === "balance" ? walletBalance : null}
                      />
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** A compact chip; the wallet's "Balance" chip shows the live balance beside it. */
function ShopChip({
  lang,
  item,
  counts,
  ticks,
  balance,
}: {
  lang: Lang;
  item: Parameters<typeof Chip>[0]["item"];
  counts: ShopBoardData["counts"];
  ticks: Parameters<typeof Chip>[0]["ticks"];
  balance: string | null;
}) {
  return (
    <span className="flex items-center [--chip-h:1.75rem] [--chip-px:0.4375rem] [--chip-text:0.84375rem] max-lg:[@media(max-height:760px)]:[--chip-h:1.5rem]">
      <Chip item={item} lang={lang} counts={counts} ticks={ticks} />
      {balance ? <span className="ml-1 text-xs font-bold tabular-nums text-ink-700">{balance}</span> : null}
    </span>
  );
}
