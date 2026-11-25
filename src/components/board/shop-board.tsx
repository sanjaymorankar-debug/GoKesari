import Link from "next/link";
import clsx from "clsx";

import { formatRupees } from "@/lib/board/format";
import { L, LANG_TAG, tr, UI, type Lang } from "@/lib/board/i18n";
import { addProductPath } from "@/lib/shop-setup-links";
import { SHOP_DO_NOW, SHOP_MENUS, visibleItems, visibleMenus } from "@/lib/board/menus";
import type { UserRole } from "@/server/db/schema";
import type { BoardHeaderData } from "@/server/board-header-data";
import type { ShopBoardData } from "@/server/board-data";
import type { ShopAlert } from "@/components/seller/seller-home";

import type { NewOrderCard, ShopToday } from "@/server/services/shop-today";

import { BoardHeader } from "./board-header";
import { NewOrdersCard } from "./new-orders-card";
import { Icon } from "./icons";
import { Banner, Chip, CountBadge, DoNowStrip, MoreChip, TONE_BLOCK, TONE_ICON, Tile } from "./tiles";

interface Props {
  lang: Lang;
  user: { name: string | null; email: string; role: UserRole };
  header: BoardHeaderData;
  shop: { name: string; slug: string };
  data: ShopBoardData;
  /** Account alerts, most serious first; at most two show, the rest behind "Today's work". */
  alerts?: ShopAlert[];
  /** Phone home: the newest orders waiting for Accept / Reject. */
  newOrders?: NewOrderCard[];
  /** Phone home: today's sales; null when not read or not allowed. */
  today?: ShopToday | null;
}

const QUICK = {
  addProduct: L("Add product", "उत्पाद जोड़ें", "उत्पादन जोडा"),
  updatePrices: L("Update prices & stock", "कीमत और स्टॉक बदलें", "किंमत आणि साठा बदला"),
  needsPrice: L("{n} products need a price — customers can't buy them yet", "{n} उत्पादों की कीमत बाकी है — ग्राहक अभी नहीं खरीद सकते", "{n} उत्पादनांची किंमत बाकी आहे — ग्राहक अजून खरेदी करू शकत नाहीत"),
  setPrices: L("Set prices", "कीमत डालें", "किंमत भरा"),
  wallet: L("Wallet balance", "वॉलेट बैलेंस", "वॉलेट शिल्लक"),
  quick: L("Quick actions", "तुरंत काम", "झटपट कामे"),
  todaySales: L("Today's sales", "आज की बिक्री", "आजची विक्री"),
  orders: L("{n} orders", "{n} ऑर्डर", "{n} ऑर्डर"),
  oneOrder: L("1 order", "1 ऑर्डर", "1 ऑर्डर"),
} as const;

/**
 * Shop owner home board on touch screens (`/shop` below the lg breakpoint;
 * wider screens get the Seller Central home): account alerts (only when there is one),
 * the "Do now" strip and the sixteen menus. Phones: two columns of tiles,
 * each one large target. Wide screens: two columns of rows — the menu on the
 * left, its submenu chips on the right.
 */
export function ShopBoard({ lang, user, header, shop, data, alerts = [], newOrders = [], today = null }: Props) {
  const params = { shopSlug: shop.slug, features: data.features };
  const menus = visibleMenus(SHOP_MENUS, user.role, params, "shop");
  const doNow = visibleItems(SHOP_DO_NOW, user.role, params);
  const ticks = { bankVerified: data.facts.bankVerified, shopVerified: data.facts.shopVerified };
  const walletBalance = formatRupees(data.facts.walletBalancePaise);
  const extras = { balance: walletBalance };

  return (
    <div data-tile-board="shop" lang={LANG_TAG[lang]} className="flex min-h-[100svh] flex-col bg-[var(--gk-bg)] text-ink-900 max-lg:min-h-0">
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

        {/* Phones and tablets: new orders first, then the two jobs owners do most (docs/ux-mobile-2026-11). */}
        <QuickPanel lang={lang} counts={data.counts} walletBalance={walletBalance} newOrders={newOrders} today={today} />

        <div className="max-lg:hidden">
          <DoNowStrip items={doNow} lang={lang} counts={data.counts} />
        </div>

        {/* Touch screens: sixteen tiles, two columns, scrolling below the quick actions. */}
        <nav aria-label={tr(UI.board, lang)} className="flex flex-col lg:hidden">
          <div className="grid grid-cols-2 gap-1.5 [grid-auto-rows:minmax(4.5rem,auto)]">
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

/** The top of the phone home: a big "New orders (n)" card, Add product, Update prices & stock, the Needs-price alert. */
function QuickPanel({
  lang,
  counts,
  walletBalance,
  newOrders,
  today,
}: {
  lang: Lang;
  counts: ShopBoardData["counts"];
  walletBalance: string | null;
  newOrders: NewOrderCard[];
  today: ShopToday | null;
}) {
  const n = counts.shopNew ?? 0;
  const needsPrice = counts.shopNeedsPrice ?? 0;
  return (
    <section aria-label={tr(QUICK.quick, lang)} className="order-first flex flex-col gap-2 lg:hidden" data-testid="shop-quick">
      <NewOrdersCard lang={lang} total={Math.max(n, newOrders.length)} orders={newOrders} />
      <div className="grid grid-cols-2 gap-2">
        <Link
          href={addProductPath()}
          data-testid="shop-quick-add-product"
          className="flex min-h-14 items-center justify-center gap-2 rounded-2xl border-2 border-kesari-600 bg-white px-2 text-center text-base font-bold leading-tight text-kesari-800"
        >
          <Icon name="plus" size={20} className="shrink-0" />
          {tr(QUICK.addProduct, lang)}
        </Link>
        <Link
          href="/shop/my-products"
          data-testid="shop-quick-update-prices"
          className="flex min-h-14 items-center justify-center gap-2 rounded-2xl border-2 border-kesari-600 bg-white px-2 text-center text-base font-bold leading-tight text-kesari-800"
        >
          <Icon name="tag" size={20} className="shrink-0" />
          {tr(QUICK.updatePrices, lang)}
        </Link>
      </div>
      {needsPrice > 0 ? (
        <Link
          href="/shop/my-products?status=NEEDS_PRICE"
          data-testid="shop-quick-needs-price"
          className="flex min-h-12 items-center gap-2 rounded-2xl border border-amber-400 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900"
        >
          <Icon name="triangle-alert" size={18} className="shrink-0" />
          <span className="min-w-0 flex-1">{tr(QUICK.needsPrice, lang).replace("{n}", String(needsPrice))}</span>
          <span className="shrink-0 font-bold underline">{tr(QUICK.setPrices, lang)}</span>
        </Link>
      ) : null}
      {today || walletBalance ? (
        <div className={clsx("grid gap-2", today && walletBalance ? "grid-cols-2" : "grid-cols-1")}>
          {today ? (
            <Link href="/shop/analytics" className="flex min-h-14 flex-col justify-center rounded-2xl border border-[var(--gk-line)] bg-white px-3 py-2" data-testid="shop-quick-today">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-600">{tr(QUICK.todaySales, lang)}</span>
              <span className="text-lg font-bold tabular-nums text-ink-900">{formatRupees(today.salesPaise) ?? "₹0"}</span>
              <span className="text-xs text-ink-600">{tr(today.orders === 1 ? QUICK.oneOrder : QUICK.orders, lang).replace("{n}", String(today.orders))}</span>
            </Link>
          ) : null}
          {walletBalance ? (
            <Link href="/shop/wallet" className="flex min-h-14 flex-col justify-center rounded-2xl border border-[var(--gk-line)] bg-white px-3 py-2" data-testid="shop-quick-wallet">
              <span className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-ink-600">
                <Icon name="wallet" size={14} className="text-green-700" />
                {tr(QUICK.wallet, lang)}
              </span>
              <span className="text-lg font-bold tabular-nums text-ink-900">{walletBalance}</span>
            </Link>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
