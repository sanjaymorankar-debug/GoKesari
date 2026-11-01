import Link from "next/link";
import clsx from "clsx";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { isFeatureEnabledForShop } from "@/server/services/feature-flags";
import { GstImportPanel } from "@/components/accounts/gst-import-panel";
import { GstLinkPanel, type GstLinkInfo } from "@/components/accounts/gst-link-panel";
import { Badge } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { CA_NOTE, type FilingFrequency } from "@/lib/accounts/constants";
import type { DueDate, Heads } from "@/lib/accounts/gst-liability";
import { ACCOUNTS_NAV, ACCOUNTS_TEXT } from "@/lib/accounts/menu";
import { formatPaise } from "@/lib/money";
import { getSettings, todayIst } from "@/server/accounts/books";
import { getPortalLink, GST_LINK_CONSENT_TEXT, gstLiability, listImports, providerSummary } from "@/server/accounts/gst";
import { MOCK_GST_OTP } from "@/server/accounts/gst-returns-provider";
import { currentPeriod, loadAccountsPage } from "@/server/accounts/page";

export const metadata = { title: "GST payable" };
export const dynamic = "force-dynamic";

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const HEADS: { key: keyof Heads; label: string }[] = [
  { key: "cgst", label: "CGST" },
  { key: "sgst", label: "SGST" },
  { key: "igst", label: "IGST" },
  { key: "cess", label: "Cess" },
];
const TEXT = {
  net: L("Net GST payable (estimate)", "शुद्ध देय GST (अनुमान)", "निव्वळ देय GST (अंदाज)"),
  dueDates: L("Due dates", "अंतिम तारीख़ें", "देय तारखा"),
  link: L("Link your GSTIN", "अपना GSTIN जोड़ें", "तुमचा GSTIN जोडा"),
  import: L("Import from GST portal", "GST पोर्टल से लाएँ", "GST पोर्टलवरून आणा"),
  imports: L("Recent imports", "हाल के इम्पोर्ट", "अलीकडील आयात"),
  reconcile: L("Match with GST portal", "GST पोर्टल से मिलान", "GST पोर्टलशी जुळवणी"),
};
const RETURN_LABEL: Record<string, string> = { GSTR2B: "GSTR-2B", GSTR2A: "GSTR-2A", GSTR1: "GSTR-1" };
const SOURCE_LABEL: Record<string, string> = { API: "Portal (linked)", UPLOAD_JSON: "Uploaded JSON", UPLOAD_EXCEL: "Uploaded Excel" };

const money = (paise: number) => formatPaise(Math.round(paise));
const sum = (h: Heads) => h.cgst + h.sgst + h.igst + h.cess;
const add = (a: Heads, b: Heads): Heads => ({ cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst, igst: a.igst + b.igst, cess: a.cess + b.cess });
const ZERO: Heads = { cgst: 0, sgst: 0, igst: 0, cess: 0 };

function monthName(period: string): string {
  return new Date(`${period}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

function shiftMonth(period: string, delta: number): string {
  const d = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function DueRow({ due, today }: { due: DueDate; today: string }) {
  const days = daysBetween(today, due.dueDate);
  const tone = days < 0 ? "text-red-800 bg-red-50 border-red-200" : days <= 3 ? "text-red-700 bg-red-50 border-red-200" : "text-ink-800 bg-white border-[var(--gk-line)]";
  return (
    <li className={clsx("flex min-h-11 items-center justify-between gap-2 rounded-xl border px-3 py-1.5", tone)}>
      <span className="min-w-0">
        <span className="block font-semibold">{due.label}</span>
        <span className="block text-xs">Due {new Date(`${due.dueDate}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}</span>
      </span>
      <span className="shrink-0 text-right text-sm font-bold tabular-nums">
        {days < 0 ? `Past due by ${-days} day${days === -1 ? "" : "s"}` : days === 0 ? "Due today" : `${days} day${days === 1 ? "" : "s"} left`}
      </span>
    </li>
  );
}

/** docs/inventory-accounting-2026-10, Part 3: GST payable, due dates, portal link and imports. */
export default async function GstPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  const period = typeof params.period === "string" && PERIOD.test(params.period) ? params.period : currentPeriod();
  const settings = await getSettings(shop.id);
  const frequency: FilingFrequency = params.frequency === "MONTHLY" || params.frequency === "QUARTERLY" ? params.frequency : settings.filingFrequency;
  const [view, link, imports] = await Promise.all([gstLiability(shop.id, period, frequency), getPortalLink(shop.id), listImports(shop.id)]);
  const provider = providerSummary();
  const today = todayIst();

  const shopParam = shopQuery ? `&${shopQuery.slice(1)}` : "";
  const here = (p: string, f: FilingFrequency = frequency) => `/shop/accounts/gst?period=${p}&frequency=${f}${shopParam}`;
  // Billing v2 (docs/billing §9): filing on the portal through the GSP.
  const billingV2 = await isFeatureEnabledForShop("billing_v2", shop);
  const reconcileHref = `/shop/accounts/gst/reconcile?period=${view.months[view.months.length - 1].period}${shopParam}`;
  const nav = ACCOUNTS_NAV.find((n) => n.key === "gst")!;

  const first = view.months[0];
  const outputOwn = view.months.reduce((acc, m) => add(acc, m.outputOwn), ZERO);
  const outputOnline = view.months.reduce((acc, m) => add(acc, m.outputOnline), ZERO);
  const ineligible = view.months.reduce((acc, m) => acc + sum(m.ineligibleItc), 0);
  const expenseGst = view.months.reduce((acc, m) => acc + m.expenseGstPaise, 0);
  const pending = sum(view.total.pendingItc);
  const carry = sum(view.total.carryForward);
  const step = frequency === "QUARTERLY" ? 3 : 1;
  const linkInfo: GstLinkInfo | null = link
    ? {
        status: link.status,
        gstin: link.gstin,
        portalUsername: link.portalUsername,
        provider: link.provider,
        lastSyncAt: link.lastSyncAt ? link.lastSyncAt.toISOString() : null,
        tokenExpiresAt: link.tokenExpiresAt ? link.tokenExpiresAt.toISOString() : null,
        lastError: link.lastError,
      }
    : null;

  const columns: { label: string; pick: (h: keyof Heads) => number }[] = [
    { label: "Output GST", pick: (h) => view.total.output[h] },
    { label: "Eligible ITC (reconciled)", pick: (h) => view.total.eligibleItc[h] },
    { label: "Credit brought forward", pick: (h) => first.broughtForward[h] },
    { label: "Cash payable", pick: (h) => view.total.cash[h] },
    { label: "Carried forward", pick: (h) => view.total.carryForward[h] },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="gst" shopQuery={shopQuery} />
      <AccountsHeader
        title={tr(nav.label, lang) + " — " + tr(ACCOUNTS_TEXT.gstPayable, lang)}
        subtitle={`${shop.name}${shop.gstin ? ` · GSTIN ${shop.gstin}` : " · no GSTIN on the shop profile"}`}
        action={
          <span className="flex flex-wrap gap-2">
            {billingV2 ? (
              <Link href={`/shop/accounts/gst/returns${shopQuery}`} className="inline-flex min-h-11 items-center rounded-xl border border-violet-700 px-4 text-sm font-semibold text-violet-800 hover:bg-violet-50">
                Returns on the portal →
              </Link>
            ) : null}
            <Link href={reconcileHref} className="inline-flex min-h-11 items-center rounded-xl bg-violet-700 px-4 text-sm font-semibold text-white hover:bg-violet-800">
              {tr(TEXT.reconcile, lang)} →
            </Link>
          </span>
        }
      />

      {/* Period and frequency */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Link href={here(shiftMonth(period, -step))} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-[var(--gk-line)] bg-white px-3 font-semibold hover:bg-kesari-50" aria-label="Previous period">
          ←
        </Link>
        <form method="get" className="flex flex-wrap items-center gap-2">
          {shopQuery ? <input type="hidden" name="shop" value={shopQuery.slice(6)} /> : null}
          <label className="sr-only" htmlFor="gst-period">
            Month
          </label>
          <input id="gst-period" type="month" name="period" defaultValue={period} className="min-h-11 rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm" />
          <label className="sr-only" htmlFor="gst-frequency">
            Filing frequency
          </label>
          <select id="gst-frequency" name="frequency" defaultValue={frequency} className="min-h-11 rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm">
            <option value="MONTHLY">Monthly</option>
            <option value="QUARTERLY">Quarterly (QRMP)</option>
          </select>
          <button type="submit" className="min-h-11 rounded-xl bg-kesari-700 px-4 text-sm font-semibold text-white hover:bg-kesari-800">
            Show
          </button>
        </form>
        <Link href={here(shiftMonth(period, step))} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-[var(--gk-line)] bg-white px-3 font-semibold hover:bg-kesari-50" aria-label="Next period">
          →
        </Link>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_20rem]">
        <section aria-labelledby="gst-net" className="space-y-3">
          {/* Headline figure */}
          <div className="rounded-2xl bg-violet-100 p-4">
            <h2 id="gst-net" className="text-sm font-semibold text-ink-700">
              {tr(TEXT.net, lang)} · {frequency === "QUARTERLY" ? `Quarter ${monthName(view.months[0].period)} – ${monthName(view.months[2].period)}` : monthName(period)}
            </h2>
            <p className="text-3xl font-bold tabular-nums text-violet-900 sm:text-4xl" data-testid="gst-net-payable">
              {money(view.total.totalCash)}
            </p>
            {carry > 0 ? <p className="text-sm text-ink-700">Credit left to carry forward: {money(carry)}</p> : null}
            <p className="mt-2 rounded-lg bg-white/70 px-2 py-1 text-xs font-medium text-ink-800" role="note">
              {lang === "en" ? CA_NOTE : `${tr(ACCOUNTS_TEXT.caNote, lang)} ${CA_NOTE}`}
            </p>
          </div>

          {/* Per head */}
          <div className="overflow-x-auto rounded-2xl border border-[var(--gk-line)] bg-white">
            <table className="w-full min-w-[36rem] text-sm">
              <caption className="sr-only">GST by head for the period</caption>
              <thead className="bg-violet-50 text-left text-xs text-ink-700">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Head
                  </th>
                  {columns.map((c) => (
                    <th key={c.label} scope="col" className="px-3 py-2 text-right">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {HEADS.map((h) => (
                  <tr key={h.key} className="border-t border-[var(--gk-line)]">
                    <th scope="row" className="px-3 py-2 text-left font-semibold">
                      {h.label}
                    </th>
                    {columns.map((c) => (
                      <td key={c.label} className={clsx("px-3 py-2 text-right tabular-nums", c.label === "Cash payable" && "font-semibold text-violet-900")}>
                        {money(c.pick(h.key))}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="border-t-2 border-[var(--gk-line)] bg-cream-50 font-bold">
                  <th scope="row" className="px-3 py-2 text-left">
                    Total
                  </th>
                  {columns.map((c) => (
                    <td key={c.label} className="px-3 py-2 text-right tabular-nums">
                      {money(HEADS.reduce((n, h) => n + c.pick(h.key), 0))}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          {frequency === "QUARTERLY" ? (
            <div className="overflow-x-auto rounded-2xl border border-[var(--gk-line)] bg-white">
              <table className="w-full min-w-[32rem] text-sm">
                <caption className="px-3 pt-2 text-left text-sm font-semibold text-ink-900">Month by month</caption>
                <thead className="text-left text-xs text-ink-700">
                  <tr>
                    <th scope="col" className="px-3 py-2">
                      Month
                    </th>
                    <th scope="col" className="px-3 py-2 text-right">
                      Output GST
                    </th>
                    <th scope="col" className="px-3 py-2 text-right">
                      Eligible ITC
                    </th>
                    <th scope="col" className="px-3 py-2 text-right">
                      Cash payable
                    </th>
                    <th scope="col" className="px-3 py-2 text-right">
                      Carried forward
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.months.map((m) => (
                    <tr key={m.period} className="border-t border-[var(--gk-line)]">
                      <th scope="row" className="px-3 py-2 text-left font-semibold">
                        {monthName(m.period)}
                      </th>
                      <td className="px-3 py-2 text-right tabular-nums">{money(sum(m.output))}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(sum(m.eligibleItc))}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{money(m.setOff.totalCash)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(sum(m.setOff.carryForward))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-2xl bg-amber-50 p-3 ring-1 ring-amber-200">
              <h3 className="text-sm font-semibold text-ink-900">ITC waiting for reconciliation</h3>
              <p className="text-xl font-bold tabular-nums text-amber-900">{money(pending)}</p>
              <p className="text-xs text-ink-700">
                GST on your purchase bills that is not yet matched with your suppliers&apos; filings on the portal. It counts only once it appears in GSTR-2B.{" "}
                <Link href={reconcileHref} className="font-semibold text-violet-800 underline">
                  Reconcile
                </Link>
              </p>
              {ineligible > 0 || expenseGst > 0 ? (
                <p className="mt-1 text-xs text-ink-600">
                  {ineligible > 0 ? `Not eligible / reversed: ${money(ineligible)}. ` : ""}
                  {expenseGst > 0 ? `GST on expenses (not in this estimate): ${money(expenseGst)}.` : ""}
                </p>
              ) : null}
            </div>
            <div className="rounded-2xl bg-teal-50 p-3 ring-1 ring-teal-200">
              <h3 className="text-sm font-semibold text-ink-900">Output from your own invoices vs GoKesari orders</h3>
              <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 text-sm">
                <dt>Your own sales invoices</dt>
                <dd className="text-right font-semibold tabular-nums">{money(sum(outputOwn))}</dd>
                <dt>GoKesari orders (net of credit notes)</dt>
                <dd className="text-right font-semibold tabular-nums">{money(sum(outputOnline))}</dd>
                <dt className="border-t border-teal-200 pt-1 font-semibold">Output GST</dt>
                <dd className="border-t border-teal-200 pt-1 text-right font-bold tabular-nums">{money(sum(view.total.output))}</dd>
              </dl>
            </div>
          </div>
        </section>

        <aside className="space-y-3">
          <section aria-labelledby="gst-due" className="rounded-2xl border border-[var(--gk-line)] bg-white p-3">
            <h2 id="gst-due" className="mb-2 text-base font-bold text-ink-900">
              {tr(TEXT.dueDates, lang)}
            </h2>
            {view.dueDates.length ? (
              <ul className="space-y-1.5">
                {view.dueDates.map((d) => (
                  <DueRow key={`${d.returnType}-${d.period}`} due={d} today={today} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-600">No returns due for this period.</p>
            )}
            <p className="mt-2 text-xs text-ink-600">
              Reminders go out {settings.reminderDaysBefore} day(s) before each date. Filing: {frequency === "QUARTERLY" ? "Quarterly (QRMP)" : "Monthly"} —{" "}
              <Link href={`/shop/accounts/settings${shopQuery}`} className="font-semibold text-kesari-700 underline">
                change in settings
              </Link>
              .
            </p>
          </section>

          <section aria-labelledby="gst-link" className="rounded-2xl border border-[var(--gk-line)] bg-white p-3">
            <h2 id="gst-link" className="mb-2 text-base font-bold text-ink-900">
              {tr(TEXT.link, lang)}
            </h2>
            <GstLinkPanel
              shopId={shop.id}
              apiAvailable={provider.apiAvailable}
              providerName={provider.provider}
              mockOtp={provider.provider === "mock" ? MOCK_GST_OTP : null}
              defaultGstin={shop.gstin ?? ""}
              consentText={GST_LINK_CONSENT_TEXT}
              link={linkInfo}
            />
          </section>
        </aside>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_20rem]">
        <section id="gst-import" aria-labelledby="gst-import-title" className="scroll-mt-20 rounded-2xl border border-[var(--gk-line)] bg-white p-3">
          <h2 id="gst-import-title" className="mb-2 text-base font-bold text-ink-900">
            {tr(TEXT.import, lang)}
          </h2>
          <GstImportPanel shopId={shop.id} canPull={provider.apiAvailable && link?.status === "LINKED"} defaultPeriod={period < currentPeriod() ? period : shiftMonth(currentPeriod(), -1)} shopQuery={shopQuery} />
        </section>

        <section aria-labelledby="gst-imports" className="rounded-2xl border border-[var(--gk-line)] bg-white p-3">
          <h2 id="gst-imports" className="mb-2 text-base font-bold text-ink-900">
            {tr(TEXT.imports, lang)}
          </h2>
          {imports.length ? (
            <ul className="space-y-1.5 text-sm">
              {imports.slice(0, 12).map((imp) => (
                <li key={imp.id} className="rounded-xl border border-[var(--gk-line)] px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/shop/accounts/gst/reconcile?period=${imp.period}${shopParam}`} className="font-semibold text-violet-800 hover:underline">
                      {RETURN_LABEL[imp.returnType] ?? imp.returnType} · {imp.period}
                    </Link>
                    <Badge tone={imp.source === "API" ? "info" : "neutral"}>{SOURCE_LABEL[imp.source] ?? imp.source}</Badge>
                  </div>
                  <p className="text-xs text-ink-600">
                    {imp.invoiceCount} invoice(s) · {imp.createdAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}
                    {imp.warnings.length ? ` · ${imp.warnings.length} warning(s)` : ""}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-600">Nothing imported yet. Upload your GSTR-2B to see which purchase bills your suppliers have filed.</p>
          )}
        </section>
      </div>
    </div>
  );
}
