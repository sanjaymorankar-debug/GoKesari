import Link from "next/link";

import { formatClock, formatCount, formatDayMonth, formatRupees } from "@/lib/board/format";
import { LANG_TAG, ORDER_STATUS_TEXT, tr, UI, type Lang } from "@/lib/board/i18n";
import { CUSTOMER_CATEGORIES, CUSTOMER_MENUS, visibleMenus, type ResolvedMenu } from "@/lib/board/menus";
import type { UserRole } from "@/server/db/schema";
import type { BoardHeaderData } from "@/server/board-header-data";
import type { CustomerBoardData } from "@/server/board-data";

import { BoardHeader } from "./board-header";
import { BuyAgainList } from "./buy-again";
import { Icon, type IconName } from "./icons";
import { Banner, Tile } from "./tiles";

interface Props {
  lang: Lang;
  user: { name: string | null; email: string; role: UserRole } | null;
  header: BoardHeaderData;
  data: CustomerBoardData;
  timeZone: string;
  /** An invite code waiting to be applied (arrived through a friend's link). */
  referralCode?: string | null;
}

function cutoffText(hour: number): string {
  return `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? "AM" : "PM"}`;
}

/**
 * Customer home board (`/`). Phone: search, live banners, eight category
 * tiles, six menu tiles and the cart bar — all on the first screen. Wide
 * screens add the "Buy again" panel beside the tiles and a live footer line
 * on each tile.
 */
export function CustomerBoard({ lang, user, header, data, timeZone, referralCode }: Props) {
  const signedIn = Boolean(user);
  const menus = visibleMenus(CUSTOMER_MENUS, user?.role ?? "CUSTOMER", {
    subscriptionId: data.subscriptionId,
    activeOrderNumber: data.activeOrder?.orderNumber,
  });
  const trackHref = data.activeOrder ? `/orders?tab=active#order-${encodeURIComponent(data.activeOrder.orderNumber)}` : "/orders?tab=active";
  const order = data.activeOrder;
  const orderStatus = order ? tr(ORDER_STATUS_TEXT[order.status] ?? { en: order.status, hi: order.status, mr: order.status }, lang) : null;
  const balance = signedIn ? formatRupees(header.balancePaise) : null;

  const headline: Record<string, string | null> = {
    wallet: balance,
    tracking: order ? order.orderNumber : null,
  };
  const footers: Record<string, { icon: IconName; text: string } | null> = {
    shops: header.locationLabel
      ? { icon: "map-pin", text: `${formatCount(data.counts.nearbyShops, { showZero: true }) ?? ""} ${tr(UI.shopsNear, lang)} · ${header.locationLabel}` }
      : null,
    orders: order ? { icon: "package", text: `${order.orderNumber} · ${orderStatus}` } : signedIn ? { icon: "package", text: tr(UI.noActiveOrder, lang) } : null,
    subscriptions: data.tomorrow
      ? { icon: "milk", text: `${tr(UI.tomorrow, lang)} · ${data.tomorrow.firstLine}${data.tomorrow.costPaise ? ` · ${formatRupees(data.tomorrow.costPaise)}` : ""}` }
      : signedIn && data.tomorrow === null
        ? { icon: "sunrise", text: tr(UI.noSubscriptionTomorrow, lang) }
        : null,
    wallet: data.lastPayment
      ? { icon: "receipt", text: `${tr(UI.lastPaid, lang)} ${formatRupees(data.lastPayment.amountPaise)} · ${formatDayMonth(data.lastPayment.createdAt, timeZone)}` }
      : null,
    tracking: order ? { icon: "bike", text: `${order.shopName} · ${orderStatus} · ${formatClock(order.updatedAt, timeZone)}` } : null,
    profile: data.defaultAddress
      ? { icon: "map-pin", text: data.defaultAddress }
      : signedIn && data.defaultAddress === null
        ? { icon: "map-pin", text: tr(UI.noAddress, lang) }
        : null,
  };

  return (
    <div data-tile-board="customer" lang={LANG_TAG[lang]} className="flex min-h-[100svh] flex-col bg-[var(--gk-bg)] text-ink-900">
      <BoardHeader
        lang={lang}
        user={user}
        roles={header.roles}
        unreadCount={header.unread}
        extraLinks={header.extraLinks}
        context={{ kind: "customer", locationLabel: header.locationLabel, savedAddresses: header.savedAddresses, balancePaise: header.balancePaise }}
      />

      <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-1.5 px-2 pb-0 pt-2 sm:px-3 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(22rem,27rem)] lg:gap-5 lg:px-6 lg:py-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 lg:gap-3">
          <form action="/search" role="search" className="lg:hidden">
            <label className="flex h-12 items-center gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white px-3 focus-within:border-kesari-600">
              <Icon name="search" size={18} className="shrink-0 text-ink-600" />
              <input
                type="search"
                name="q"
                placeholder={tr(UI.searchShort, lang)}
                aria-label={tr(UI.searchLabel, lang)}
                className="h-full min-w-0 flex-1 bg-transparent text-base text-ink-900 placeholder:text-ink-600 focus:outline-none"
              />
            </label>
          </form>

          {/* Phones: one "Do now" strip — what is on its way, what comes tomorrow. */}
          {signedIn ? (
            <CustomerDoNow lang={lang} data={data} trackHref={trackHref} referralCode={referralCode} />
          ) : (
            <div className="lg:hidden">
              <JoinRow lang={lang} />
            </div>
          )}

          {order || data.tomorrow ? (
            <div className="hidden gap-3 max-lg:hidden lg:grid lg:grid-cols-2">
              {order ? (
                <Banner
                  testId="banner-order"
                  icon="bike"
                  iconClass="bg-kesari-700"
                  title={order.orderNumber}
                  detail={`${orderStatus} · ${order.shopName}`}
                  action={tr(UI.track, lang)}
                  href={trackHref}
                />
              ) : null}
              {data.tomorrow ? (
                <Banner
                  testId="banner-tomorrow"
                  icon="milk"
                  iconClass="bg-green-700"
                  title={`${tr(UI.tomorrow, lang)}: ${data.tomorrow.firstLine}${data.tomorrow.moreLines > 0 ? ` +${data.tomorrow.moreLines}` : ""}`}
                  detail={[
                    data.tomorrow.costPaise ? `${formatRupees(data.tomorrow.costPaise)} ${tr(UI.fromWallet, lang)}` : null,
                    data.tomorrow.beforeCutoff
                      ? lang === "en"
                        ? `change by ${cutoffText(data.tomorrow.cutoffHour)}`
                        : `${cutoffText(data.tomorrow.cutoffHour)} ${tr(UI.changeBy, lang)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  action={tr(UI.change, lang)}
                  href="/subscriptions#tomorrow"
                />
              ) : null}
            </div>
          ) : null}

          <nav aria-label={tr(UI.board, lang)}>
            <ul className="grid grid-cols-4 gap-1.5 lg:grid-cols-8 lg:gap-3">
              {CUSTOMER_CATEGORIES.map((c) => (
                <li key={c.key}>
                  <Link
                    href={c.href}
                    data-testid="board-chip"
                    data-key={`category-${c.key}`}
                    className="flex h-[3.5rem] flex-col items-center justify-center gap-0.5 rounded-2xl border border-[var(--gk-line)] bg-white px-1 hover:border-kesari-300 max-lg:[@media(max-height:760px)]:h-12 lg:h-[5.25rem] lg:gap-1.5"
                  >
                    <span aria-hidden className={`grid h-6 w-8 place-items-center rounded-lg text-base leading-none lg:h-10 lg:w-12 lg:rounded-xl lg:text-2xl ${c.bg}`}>
                      {c.emoji}
                    </span>
                    <span className="flex max-w-full items-center gap-1 truncate text-[0.8125rem] font-semibold leading-tight text-ink-900 lg:text-sm 2xl:text-base">
                      <span className="truncate lg:hidden">{c.short?.[lang] ?? tr(c.label, lang)}</span>
                      <span className="truncate max-lg:hidden">{tr(c.label, lang)}</span>
                      {c.count ? <span className="tabular-nums">{formatCount(data.counts[c.count])}</span> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label={tr(UI.board, lang)} className="flex min-h-0 flex-1 flex-col">
            <div className="grid flex-1 auto-rows-fr grid-cols-3 gap-1.5 lg:gap-4">
              {menus.map((menu: ResolvedMenu) => (
                <Tile
                  key={menu.key}
                  menu={menu}
                  lang={lang}
                  counts={data.counts}
                  signedIn={signedIn}
                  headline={menu.key === "tracking" ? null : (headline[menu.key] ?? null)}
                  footer={footers[menu.key] ?? null}
                  countWord={UI.active}
                  tagCounts="urgent"
                />
              ))}
            </div>
          </nav>
        </div>

        <aside className="hidden min-w-0 flex-col gap-4 lg:flex" aria-label={tr(UI.buyAgain, lang)}>
          <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-[var(--gk-line)] bg-white p-4" data-testid="buy-again">
            <h2 className="mb-1 flex items-center gap-2 text-lg font-bold text-ink-900">
              <Icon name="history" size={20} className="text-kesari-700" />
              {tr(UI.buyAgain, lang)}
            </h2>
            {signedIn ? (
              data.buyAgain ? (
                <BuyAgainList
                  items={data.buyAgain}
                  labels={{ add: tr(UI.add, lang), added: tr(UI.added, lang), empty: tr(UI.buyAgainEmpty, lang) }}
                />
              ) : null
            ) : (
              <div className="flex flex-col gap-3 py-4">
                <p className="text-sm text-ink-700">{tr(UI.buyAgainEmpty, lang)}</p>
                <Link href="/signin" className="flex h-11 w-max items-center rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white hover:bg-kesari-800">
                  {tr(UI.signIn, lang)}
                </Link>
                <JoinRow lang={lang} />
              </div>
            )}
          </section>
          <CartBar lang={lang} data={data} signedIn={signedIn} />
        </aside>
      </div>

      <div className="sticky bottom-0 z-30 mt-1.5 lg:hidden">
        <CartBar lang={lang} data={data} signedIn={signedIn} />
      </div>
    </div>
  );
}

/** The cart bar: item count, total and the shops — pinned to the bottom of the first screen. */
function CartBar({ lang, data, signedIn }: { lang: Lang; data: CustomerBoardData; signedIn: boolean }) {
  const cart = data.cart;
  const items = cart?.itemCount ?? 0;
  const title =
    cart && items > 0
      ? `${tr(UI.cart, lang)} · ${items} ${items === 1 ? tr(UI.item, lang) : tr(UI.items, lang)}`
      : tr(UI.cartEmpty, lang);
  const shopsText =
    cart && cart.firstShop
      ? lang === "en"
        ? `From ${cart.firstShop}${cart.otherShops > 0 ? ` +${cart.otherShops} shop${cart.otherShops === 1 ? "" : "s"}` : ""}`
        : `${cart.firstShop}${cart.otherShops > 0 ? ` +${cart.otherShops} ${tr(UI.moreShops, lang)}` : ""}`
      : null;
  return (
    <div className="flex items-center gap-3 bg-kesari-700 px-3 py-1.5 text-white lg:rounded-2xl lg:px-4 lg:py-4" data-testid="cart-bar">
      <Icon name="shopping-cart" size={26} className="shrink-0" />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="flex items-center gap-1.5 truncate text-base font-bold max-[359px]:text-sm">
          {title}
          {cart && items > 0 ? <span className="tabular-nums"> · {formatRupees(cart.totalPaise)}</span> : null}
        </span>
        {shopsText ? <span className="block truncate text-[0.8125rem] text-white">{shopsText}</span> : null}
      </span>
      <Link
        href={signedIn ? "/cart" : "/signin"}
        data-testid="board-chip"
        data-key="view-cart"
        className="flex h-12 shrink-0 items-center gap-1 rounded-xl bg-white px-3.5 text-sm font-bold text-kesari-800 hover:bg-kesari-50"
      >
        {tr(UI.viewCart, lang)}
        <Icon name="chevron-right" size={16} />
      </Link>
    </div>
  );
}

/** Phones: the customer's "Do now" — the order on its way and tomorrow's delivery, each one tap. */
function CustomerDoNow({ lang, data, trackHref, referralCode }: { lang: Lang; data: CustomerBoardData; trackHref: string; referralCode?: string | null }) {
  const order = data.activeOrder;
  const items: { key: string; icon: IconName; title: string; detail: string; href: string; live: boolean }[] = [
    {
      key: "track",
      icon: "bike",
      title: tr(UI.trackOrder, lang),
      // The status says more than the long order number, which would be cut off here.
      detail: order ? `${tr(ORDER_STATUS_TEXT[order.status] ?? { en: order.status, hi: order.status, mr: order.status }, lang)} · ${order.shopName}` : tr(UI.noOrderOnWay, lang),
      href: trackHref,
      live: Boolean(order),
    },
    {
      key: "tomorrow",
      icon: "milk",
      title: tr(UI.tomorrow, lang),
      detail: data.tomorrow ? `${data.tomorrow.firstLine}${data.tomorrow.moreLines > 0 ? ` +${data.tomorrow.moreLines}` : ""}` : tr(UI.nothingTomorrow, lang),
      href: "/subscriptions#tomorrow",
      live: Boolean(data.tomorrow),
    },
  ];
  if (referralCode) {
    items.push({ key: "invite", icon: "gift", title: tr(UI.applyInvite, lang), detail: referralCode, href: "/refer", live: true });
  }
  return (
    <nav aria-label={tr(UI.doNow, lang)} className="flex items-stretch gap-1.5 lg:hidden" data-testid="do-now">
      <span className="flex w-10 shrink-0 flex-col items-center justify-center text-center text-xs font-bold leading-tight text-kesari-800">
        <Icon name="zap" size={18} className="shrink-0" />
        <span>{tr(UI.doNow, lang)}</span>
      </span>
      <ul className="grid min-w-0 flex-1 gap-1.5" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((item) => (
          <li key={item.key} className="min-w-0">
            <Link
              href={item.href}
              data-testid="board-chip"
              data-key={`do-${item.key}`}
              className={`flex h-12 min-w-0 items-center gap-1.5 rounded-xl border-2 bg-white px-2 ${item.live ? "border-kesari-600" : "border-[var(--gk-line)]"}`}
            >
              <Icon name={item.icon} size={18} className={item.live ? "shrink-0 text-kesari-700" : "shrink-0 text-ink-600"} />
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-[0.8125rem] font-bold text-ink-900">{item.title}</span>
                <span className="block truncate text-xs font-medium text-ink-700">{item.detail}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Signed-out visitors: the two sign-up paths that used to sit below the home page's first screen. */
function JoinRow({ lang }: { lang: Lang }) {
  const links: { href: string; icon: IconName; label: string }[] = [
    { href: "/shop/register", icon: "store", label: tr(UI.runAShop, lang) },
    { href: "/delivery-partner/apply", icon: "bike", label: tr(UI.deliverForUs, lang) },
  ];
  return (
    <nav aria-label={tr(UI.join, lang)} className="grid grid-cols-2 gap-1.5 lg:max-w-xl lg:gap-3" data-testid="join-row">
      {links.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          data-testid="board-chip"
          data-key={`join-${l.href}`}
          className="flex h-12 min-w-0 items-center gap-2 rounded-xl border-2 border-[var(--gk-line)] bg-white px-2.5 text-sm font-bold text-ink-900 hover:border-kesari-300"
        >
          <Icon name={l.icon} size={18} className="shrink-0 text-kesari-700" />
          <span className="line-clamp-2 min-w-0 leading-tight">{l.label}</span>
        </Link>
      ))}
    </nav>
  );
}
