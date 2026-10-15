import Link from "next/link";
import clsx from "clsx";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { Alert } from "@/components/ui";
import { tr } from "@/lib/board/i18n";
import { ACCOUNTS_TEXT, ACCOUNTS_TILES } from "@/lib/accounts/menu";
import { todayIst } from "@/server/accounts/books";
import { loadAccountsPage, monthRange } from "@/server/accounts/page";
import { reportTable, type ReportKind } from "@/server/accounts/reports";

export const metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

const KINDS: { kind: ReportKind; label: string }[] = [
  { kind: "pnl", label: "Profit & loss" },
  { kind: "stock", label: "Stock summary" },
  { kind: "daybook", label: "Day book" },
  { kind: "purchases", label: "Purchase register" },
  { kind: "sales", label: "Sales register" },
  { kind: "gst", label: "GST summary" },
  { kind: "ledger", label: "All entries" },
];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function shiftMonth(period: string, delta: number): string {
  return new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1 + delta, 1)).toISOString().slice(0, 7);
}

function validDate(value: unknown): string | null {
  return typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null;
}

/** Quick ranges: `to` is the day after the last day (as the API takes it). */
function quickRanges(today: string): { key: string; label: string; from: string; to: string }[] {
  const thisMonth = today.slice(0, 7);
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const qFirst = `${y}-${String(m - ((m - 1) % 3)).padStart(2, "0")}`;
  const fyStart = m >= 4 ? y : y - 1;
  return [
    { key: "this-month", label: "This month", ...monthRange(thisMonth) },
    { key: "last-month", label: "Last month", ...monthRange(shiftMonth(thisMonth, -1)) },
    { key: "this-quarter", label: "This quarter", from: `${qFirst}-01`, to: monthRange(shiftMonth(qFirst, 2)).to },
    { key: "this-fy", label: `This financial year (Apr ${fyStart} – Mar ${fyStart + 1})`, from: `${fyStart}-04-01`, to: `${fyStart + 1}-04-01` },
  ];
}

function formatCell(value: string | number | null, money: boolean): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (money) return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value.toLocaleString("en-IN", { maximumFractionDigits: 3 });
}

/** docs/inventory-accounting-2026-10, Part 2: reports on screen, as Excel / PDF, and Tally XML. */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  const tile = ACCOUNTS_TILES.find((t) => t.key === "reports")!;
  const today = todayIst();
  const kind: ReportKind = KINDS.find((k) => k.kind === params.kind)?.kind ?? "pnl";

  // `to` is exclusive (as in the API and monthRange); the form sends `until`, the last day included.
  const defaults = monthRange(today.slice(0, 7));
  let from = validDate(params.from) ?? defaults.from;
  const until = validDate(params.until);
  let to = until ? addDays(until, 1) : (validDate(params.to) ?? defaults.to);
  let rangeError: string | null = null;
  if (to <= from) {
    rangeError = "The end date is before the start date — showing this month instead.";
    from = defaults.from;
    to = defaults.to;
  }
  const lastDay = addDays(to, -1);

  const table = await reportTable(shop.id, kind, from, to);
  const shopParam = shopQuery ? `&${shopQuery.slice(1)}` : "";
  const pageHref = (k: ReportKind, f: string, t: string) => `/shop/accounts/reports?kind=${k}&from=${f}&to=${t}${shopParam}`;
  const api = `/api/shops/${shop.id}/accounts/reports`;
  const range = `from=${from}&to=${to}`;
  const moneyCols = table.header.map((h) => h.includes("₹") || (kind === "gst" && h !== "Month"));
  const ranges = quickRanges(today);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="reports" shopQuery={shopQuery} />
      <AccountsHeader title={tr(tile.label, lang)} subtitle={`${shop.name} · ${tr(tile.hint, lang)}`} />

      {/* Report kind */}
      <nav aria-label="Report" className="-mx-2 mb-2 flex gap-1.5 overflow-x-auto px-2 pb-1 [scrollbar-width:none]">
        {KINDS.map((k) => (
          <Link
            key={k.kind}
            href={pageHref(k.kind, from, to)}
            aria-current={k.kind === kind ? "page" : undefined}
            className={clsx(
              "flex min-h-11 shrink-0 items-center rounded-xl px-3 text-sm font-semibold",
              k.kind === kind ? "bg-blue-700 text-white" : "border border-[var(--gk-line)] bg-white text-ink-900 hover:bg-blue-50",
            )}
          >
            {k.label}
          </Link>
        ))}
      </nav>

      {/* Range */}
      <div className="mb-3 rounded-2xl bg-blue-50 p-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {ranges.map((r) => (
            <Link
              key={r.key}
              href={pageHref(kind, r.from, r.to)}
              aria-current={r.from === from && r.to === to ? "true" : undefined}
              className={clsx(
                "inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold",
                r.from === from && r.to === to ? "bg-blue-700 text-white" : "bg-white text-ink-900 ring-1 ring-blue-200 hover:bg-blue-100",
              )}
            >
              {r.label}
            </Link>
          ))}
        </div>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="kind" value={kind} />
          {shopQuery ? <input type="hidden" name="shop" value={shopQuery.slice(6)} /> : null}
          <label className="flex flex-col text-xs font-semibold text-ink-700">
            From
            <input type="date" name="from" defaultValue={from} className="mt-0.5 min-h-11 rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-normal" required />
          </label>
          <label className="flex flex-col text-xs font-semibold text-ink-700">
            To (last day)
            <input type="date" name="until" defaultValue={lastDay} className="mt-0.5 min-h-11 rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-normal" required />
          </label>
          <button type="submit" className="min-h-11 rounded-xl bg-blue-700 px-4 text-sm font-semibold text-white hover:bg-blue-800">
            Show
          </button>
        </form>
      </div>

      {rangeError ? (
        <div className="mb-3">
          <Alert tone="warning">{rangeError}</Alert>
        </div>
      ) : null}

      <section aria-labelledby="report-title" className="rounded-2xl border border-[var(--gk-line)] bg-white">
        <div className="flex flex-wrap items-start justify-between gap-2 p-3">
          <div className="min-w-0">
            <h2 id="report-title" className="text-lg font-bold text-ink-900">
              {table.title}
            </h2>
            <p className="text-sm text-ink-600">{table.subtitle}</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <a href={`${api}/${kind}?${range}&format=xlsx`} download className="inline-flex min-h-11 items-center rounded-xl bg-green-700 px-3 text-sm font-semibold text-white hover:bg-green-800">
              Excel
            </a>
            <a href={`${api}/${kind}?${range}&format=pdf`} download className="inline-flex min-h-11 items-center rounded-xl bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800">
              PDF
            </a>
            <a
              href={`${api}/tally?${range}`}
              download
              className="inline-flex min-h-11 items-center rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-semibold text-ink-900 hover:bg-kesari-50"
              title="All vouchers of the period for TallyPrime: Gateway of Tally → Import → Transactions"
            >
              Tally XML
            </a>
          </div>
        </div>

        {table.rows.length ? (
          <div className="overflow-x-auto border-t border-[var(--gk-line)]">
            <table className="w-full text-sm">
              <caption className="sr-only">
                {table.title} — {table.subtitle}
              </caption>
              <thead className="bg-blue-50 text-xs text-ink-700">
                <tr>
                  {table.header.map((h, i) => (
                    <th key={i} scope="col" className={clsx("whitespace-nowrap px-3 py-2", moneyCols[i] ? "text-right" : "text-left")}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, r) => {
                  const blank = row.every((c) => c == null || c === "");
                  const strong = kind === "pnl" && typeof row[0] === "string" && /^(Total sales|Gross profit|Net profit)$/.test(row[0]);
                  return (
                    <tr key={r} className={clsx("border-t border-[var(--gk-line)]", strong && "bg-cream-50 font-bold", blank && "h-3")}>
                      {row.map((cell, i) => (
                        <td
                          key={i}
                          className={clsx(
                            "px-3 py-1.5",
                            typeof cell === "number" ? "whitespace-nowrap text-right tabular-nums" : "",
                            typeof cell === "number" && cell < 0 && "text-red-700",
                            i === 0 && "font-medium",
                          )}
                        >
                          {formatCell(cell, moneyCols[i])}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="border-t border-[var(--gk-line)] p-4 text-sm text-ink-600">Nothing in this period.</p>
        )}

        {table.footer.length ? (
          <div className="space-y-0.5 border-t border-[var(--gk-line)] p-3 text-sm text-ink-700">
            {table.footer.map((f, i) => (
              <p key={i}>{f}</p>
            ))}
          </div>
        ) : null}
      </section>

      <p className="mt-2 text-xs text-ink-600">
        Amounts in ₹. Excel and PDF hold the same table. Tally XML imports every voucher of the period into TallyPrime (Gateway of Tally → Import → Transactions). {tr(ACCOUNTS_TEXT.caNote, lang)}
      </p>
    </div>
  );
}
