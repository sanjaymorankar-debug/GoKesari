import Link from "next/link";
import clsx from "clsx";

import { Icon, type IconName } from "@/components/board/icons";
import { CountBadge, TONE_CHIP } from "@/components/board/tiles";
import { formatRupees } from "@/lib/board/format";
import { tr, type Lang, type Text } from "@/lib/board/i18n";
import type { CountKey, Counts } from "@/lib/board/menus";
import { SELLER_TEXT, shopStatusPill, type ResolvedSellerGroup } from "@/lib/seller/nav";
import type { ShopFacts } from "@/server/services/board-counts";
import type { MarketplaceKpis } from "@/server/services/analytics";

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
  userName: string | null;
  shop: { name: string; slug: string; status: string };
  /** Most serious first. */
  alerts: ShopAlert[];
  counts: Counts;
  facts: ShopFacts;
  /** The shop's last 30 days; null when the owner may not see reports or the read failed. */
  kpis: MarketplaceKpis | null;
  /** Legal documents: how many block orders now, how many fall due soon; null when the feature is off. */
  legal: { blocking: number; dueSoon: number } | null;
  groups: ResolvedSellerGroup[];
}

const pct = (value: number | null) => (value == null ? "—" : `${Math.round(value * 1000) / 10}%`);

/**
 * Seller Central home (`/shop`), laid out the way Amazon Seller Central's
 * home is: what needs doing first ("Action required"), then today's order
 * pipeline, the shop's numbers and account health side by side, and every
 * seller tool grouped by job at the bottom. Each figure links to the page
 * where it is worked on; a figure that could not be read is left out.
 */
export function SellerHome({ lang, userName, shop, alerts, counts, facts, kpis, legal, groups }: Props) {
  const pill = shopStatusPill(shop.status);
  const firstName = userName?.trim().split(/\s+/)[0] ?? null;

  return (
    <div className="flex flex-col gap-5 lg:gap-6" data-testid="seller-home">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
            {tr(SELLER_TEXT.greeting, lang)}
            {firstName ? `, ${firstName}` : ""}
          </h1>
          <p className="mt-1 hidden flex-wrap items-center gap-2 text-sm text-ink-600 md:flex">
            <span className="font-semibold text-ink-900">{shop.name}</span>
            <span className={clsx("rounded-full px-2 py-0.5 text-xs font-bold", pill.className)}>{tr(pill.label, lang)}</span>
          </p>
        </div>
        {shop.status === "APPROVED" ? (
          <Link href={`/shops/${shop.slug}`} className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 text-sm font-semibold text-ink-900 hover:bg-slate-50 lg:hidden">
            <Icon name="store" size={16} />
            {tr(SELLER_TEXT.visitStore, lang)}
          </Link>
        ) : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-3 lg:gap-6">
        <div className="flex min-w-0 flex-col gap-5 lg:col-span-2 lg:gap-6">
          <Panel title={tr(SELLER_TEXT.actionRequired, lang)} icon="circle-alert" testId="seller-actions">
            {alerts.length > 0 ? (
              <ul className="divide-y divide-slate-100" data-testid="seller-alerts">
                {alerts.map((a) => (
                  <li key={a.key} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0" data-testid={`seller-alert-${a.key}`} role="status">
                    <span className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-full text-white", a.tone === "danger" ? "bg-red-700" : "bg-amber-600")}>
                      <Icon name={a.icon} size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-bold text-ink-900">{a.title}</span>
                      {a.detail ? <span className="block text-sm text-ink-600">{a.detail}</span> : null}
                    </span>
                    <Link href={a.href} className="inline-flex h-10 shrink-0 items-center rounded-lg bg-kesari-700 px-3.5 text-sm font-bold text-white hover:bg-kesari-800">
                      {a.action}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 text-sm text-leaf-700" data-testid="seller-all-clear">
                <Icon name="circle-check" size={18} />
                {tr(SELLER_TEXT.allCaughtUp, lang)}
              </p>
            )}
          </Panel>

          <Panel
            title={tr(SELLER_TEXT.todaysOrders, lang)}
            icon="package"
            action={{ href: "/shop/orders", label: tr(SELLER_TEXT.viewAll, lang) }}
            testId="seller-pipeline"
          >
            <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <Stat href="/shop/orders?status=new" label={SELLER_TEXT.newOrders} value={counts.shopNew} lang={lang} urgent />
              <Stat href="/shop/orders?status=packing" label={SELLER_TEXT.packing} value={counts.shopPacking} lang={lang} />
              <Stat href="/shop/orders?status=ready" label={SELLER_TEXT.ready} value={counts.shopReady} lang={lang} />
              <Stat href="/shop/orders?status=out" label={SELLER_TEXT.out} value={counts.shopOut} lang={lang} />
            </ul>
          </Panel>

          {kpis ? (
            <Panel
              title={tr(SELLER_TEXT.performance, lang)}
              icon="chart-line"
              action={{ href: "/shop/analytics", label: tr(SELLER_TEXT.fullAnalytics, lang) }}
              testId="seller-performance"
            >
              <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
                <Metric label={tr(SELLER_TEXT.sales, lang)} value={formatRupees(kpis.orders.placedValuePaise) ?? "—"} />
                <Metric label={tr(SELLER_TEXT.ordersPlaced, lang)} value={String(kpis.orders.placed)} />
                <Metric label={tr(SELLER_TEXT.delivered, lang)} value={String(kpis.orders.delivered)} />
                <Metric label={tr(SELLER_TEXT.repeatCustomers, lang)} value={pct(kpis.customers.repeatRate)} />
                <Metric label={tr(SELLER_TEXT.fillRate, lang)} value={pct(kpis.fillRate)} />
                <Metric label={tr(SELLER_TEXT.onTime, lang)} value={pct(kpis.onTime.rate)} />
                <Metric label={tr(SELLER_TEXT.cancelled, lang)} value={pct(kpis.cancellationRate)} />
              </dl>
            </Panel>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-5 lg:gap-6">
          {facts.walletBalancePaise != null ? (
            <Link
              href="/shop/wallet"
              className="flex items-center gap-3 rounded-xl bg-ink-900 p-4 text-white shadow-sm hover:bg-ink-700"
              data-testid="seller-wallet"
            >
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/10 text-kesari-300">
                <Icon name="wallet" size={22} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-slate-300">{tr(SELLER_TEXT.walletBalance, lang)}</span>
                <span className="block text-2xl font-bold tabular-nums">{formatRupees(facts.walletBalancePaise)}</span>
              </span>
              <Icon name="chevron-right" size={20} className="shrink-0 text-slate-300" />
            </Link>
          ) : null}

          <Panel title={tr(SELLER_TEXT.attention, lang)} icon="zap" testId="seller-attention">
            <ul className="-my-1 divide-y divide-slate-100">
              <Row href="/shop/inventory" icon="boxes" label={SELLER_TEXT.lowStock} lang={lang} count="shopLowStock" counts={counts} />
              <Row href="/shop/returns?tab=requests" icon="undo-2" label={SELLER_TEXT.returnRequests} lang={lang} count="shopReturnRequests" counts={counts} />
              <Row href="/shop/disputes?tab=open" icon="scale" label={SELLER_TEXT.openDisputes} lang={lang} count="shopOpenDisputes" counts={counts} urgent />
              <Row href="/shop/prices#price-requests" icon="tag" label={SELLER_TEXT.priceRequests} lang={lang} count="shopPriceRequests" counts={counts} />
            </ul>
          </Panel>

          <Panel title={tr(SELLER_TEXT.accountHealth, lang)} icon="shield-check" testId="seller-health">
            <ul className="-my-1 divide-y divide-slate-100">
              <Health href="/shop/verification" label={tr(SELLER_TEXT.shopVerified, lang)} ok={facts.shopVerified} lang={lang} />
              <Health href="/shop/bank-account" label={tr(SELLER_TEXT.bankVerified, lang)} ok={facts.bankVerified} lang={lang} />
              {legal ? (
                <Health href="/shop/legal-documents" label={tr(SELLER_TEXT.legalDocs, lang)} ok={legal.blocking === 0 && legal.dueSoon === 0} lang={lang} />
              ) : null}
            </ul>
          </Panel>
        </div>
      </div>

      <section aria-labelledby="seller-tools" data-testid="seller-tools">
        <h2 id="seller-tools" className="mb-3 text-lg font-bold text-ink-900">
          {tr(SELLER_TEXT.allTools, lang)}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {groups.flatMap((g) =>
            g.menus.map((m) => {
              const value = m.count ? counts[m.count] : undefined;
              return (
                <div key={m.key} className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm" data-testid="seller-tool" data-key={m.key}>
                  <Link href={m.href} className="group flex items-center gap-3">
                    <span className={clsx("grid h-10 w-10 shrink-0 place-items-center rounded-lg", TONE_CHIP[m.tone])}>
                      <Icon name={m.icon ?? "store"} size={20} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-semibold uppercase tracking-wide text-ink-500">{tr(g.label, lang)}</span>
                      <span className="block truncate text-base font-bold text-ink-900 group-hover:text-kesari-800 group-hover:underline">{tr(m.label, lang)}</span>
                    </span>
                    <CountBadge value={value} tone={m.urgent ? "alert" : "accent"} />
                  </Link>
                  {m.items.length + m.more.length > 0 ? (
                    <ul className="mt-3 flex flex-wrap gap-1.5">
                      {[...m.items, ...m.more].map((item) => (
                        <li key={item.key}>
                          <Link
                            href={item.href}
                            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 text-sm text-ink-700 hover:border-kesari-300 hover:bg-kesari-50 hover:text-ink-900"
                          >
                            {tr(item.label, lang)}
                            <CountBadge value={item.count ? counts[item.count] : undefined} tone={item.urgent ? "alert" : "soft"} />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            }),
          )}
        </div>
      </section>
    </div>
  );
}

function Panel({
  title,
  icon,
  action,
  testId,
  children,
}: {
  title: string;
  icon: IconName;
  action?: { href: string; label: string };
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm" data-testid={testId}>
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
        <Icon name={icon} size={18} className="shrink-0 text-kesari-700" />
        <h2 className="min-w-0 flex-1 text-base font-bold text-ink-900">{title}</h2>
        {action ? (
          <Link href={action.href} className="inline-flex min-h-9 items-center gap-0.5 text-sm font-semibold text-kesari-800 hover:underline">
            {action.label}
            <Icon name="chevron-right" size={16} />
          </Link>
        ) : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Stat({ href, label, value, lang, urgent }: { href: string; label: Text; value: number | undefined; lang: Lang; urgent?: boolean }) {
  const waiting = urgent && (value ?? 0) > 0;
  return (
    <li>
      <Link
        href={href}
        className={clsx(
          "flex h-full flex-col rounded-lg border p-3 hover:shadow-sm",
          waiting ? "border-kesari-600 bg-kesari-50" : "border-slate-200 bg-slate-50 hover:bg-white",
        )}
      >
        <span className="text-sm font-semibold text-ink-600">{tr(label, lang)}</span>
        <span className={clsx("mt-1 text-3xl font-bold tabular-nums", waiting ? "text-kesari-800" : "text-ink-900")}>{value ?? "—"}</span>
      </Link>
    </li>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-sm text-ink-600">{label}</dt>
      <dd className="mt-0.5 truncate text-xl font-bold tabular-nums text-ink-900">{value}</dd>
    </div>
  );
}

function Row({
  href,
  icon,
  label,
  lang,
  count,
  counts,
  urgent,
}: {
  href: string;
  icon: IconName;
  label: Text;
  lang: Lang;
  count: CountKey;
  counts: Counts;
  urgent?: boolean;
}) {
  return (
    <li>
      <Link href={href} className="flex min-h-11 items-center gap-2.5 py-1.5 text-sm text-ink-700 hover:text-ink-900">
        <Icon name={icon} size={18} className="shrink-0 text-ink-500" />
        <span className="min-w-0 flex-1 font-medium">{tr(label, lang)}</span>
        <CountBadge value={counts[count]} tone={urgent ? "alert" : "accent"} showZero />
        <Icon name="chevron-right" size={16} className="shrink-0 text-ink-400" />
      </Link>
    </li>
  );
}

function Health({ href, label, ok, lang }: { href: string; label: string; ok: boolean | undefined; lang: Lang }) {
  return (
    <li>
      <Link href={href} className="flex min-h-11 items-center gap-2.5 py-1.5 text-sm text-ink-700 hover:text-ink-900">
        <span className="min-w-0 flex-1 font-medium">{label}</span>
        {ok === undefined ? (
          <span className="text-ink-500">—</span>
        ) : ok ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-leaf-100 px-2 py-0.5 text-xs font-bold text-leaf-700">
            <Icon name="check" size={14} strokeWidth={3} />
            {tr(SELLER_TEXT.ok, lang)}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">
            <Icon name="triangle-alert" size={14} />
            {tr(SELLER_TEXT.needsAction, lang)}
          </span>
        )}
        <Icon name="chevron-right" size={16} className="shrink-0 text-ink-400" />
      </Link>
    </li>
  );
}
