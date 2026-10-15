import Link from "next/link";
import clsx from "clsx";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { AddExpenseForm } from "@/components/accounts/expense-forms";
import { CancelEntryButton } from "@/components/accounts/payment-forms";
import { Badge, EmptyState } from "@/components/ui";
import { tr } from "@/lib/board/i18n";
import { BOOK_ACCOUNT_LABELS, EXPENSE_CATEGORY_LABELS, type BookAccount } from "@/lib/accounts/constants";
import { ACCOUNTS_TILES } from "@/lib/accounts/menu";
import { formatPaise } from "@/lib/money";
import { todayIst } from "@/server/accounts/books";
import { cashBook, dayBook, listExpenses, type BookLine } from "@/server/accounts/money";
import { currentPeriod, loadAccountsPage } from "@/server/accounts/page";
import { listParties } from "@/server/accounts/parties";

export const metadata = { title: "Cash, bank & expenses" };
export const dynamic = "force-dynamic";

const TABS = [
  { key: "cash", label: "Cash book" },
  { key: "bank", label: "Bank book" },
  { key: "day", label: "Day book" },
  { key: "expenses", label: "Expenses" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const VOUCHER_LABEL: Record<string, string> = {
  PURCHASE: "Purchase",
  SALE: "Sale",
  PAYMENT: "Payment",
  RECEIPT: "Receipt",
  EXPENSE: "Expense",
  WRITE_OFF: "Write-off",
  OPENING: "Opening",
  REVERSAL: "Reversal",
};
const MODE_LABEL: Record<string, string> = { CASH: "Cash", UPI: "UPI", BANK: "Bank", CARD: "Card", CREDIT: "Not paid yet" };

const dateLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" });

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function href(params: Record<string, string>, shopQuery: string) {
  const sp = new URLSearchParams(shopQuery.slice(1));
  for (const [k, v] of Object.entries(params)) sp.set(k, v);
  return `/shop/accounts/money?${sp.toString()}`;
}

function Facts({ items }: { items: { label: string; value: number; tone?: string }[] }) {
  return (
    <ul className="mb-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
      {items.map((f) => (
        <li key={f.label} className="flex min-h-14 flex-col justify-center rounded-xl border border-[var(--gk-line)] bg-white px-3 py-1.5">
          <span className="text-xs font-semibold text-ink-600">{f.label}</span>
          <span className={clsx("text-lg font-bold tabular-nums", f.tone ?? "text-ink-900")}>{formatPaise(f.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function entryText(l: BookLine) {
  return [l.partyName, l.narration].filter(Boolean).join(" · ");
}

async function Book({ shopId, account, from, toExclusive }: { shopId: string; account: "CASH" | "BANK"; from: string; toExclusive: string }) {
  const book = await cashBook(shopId, account, from, toExclusive);
  return (
    <>
      <Facts
        items={[
          { label: "Opening", value: book.openingPaise },
          { label: "Money in", value: book.inPaise, tone: "text-green-800" },
          { label: "Money out", value: book.outPaise, tone: "text-red-800" },
          { label: "Closing", value: book.closingPaise, tone: book.closingPaise < 0 ? "text-red-800" : "text-teal-800" },
        ]}
      />
      {book.lines.length === 0 ? (
        <EmptyState title={`No ${account === "CASH" ? "cash" : "bank / UPI"} entries in these dates`} />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-[var(--gk-line)] bg-white">
          <table className="w-full min-w-[36rem] text-sm">
            <caption className="sr-only">{account === "CASH" ? "Cash book" : "Bank book"}</caption>
            <thead>
              <tr className="border-b border-[var(--gk-line)] text-left text-xs text-ink-600">
                <th scope="col" className="px-3 py-2">Date</th>
                <th scope="col" className="px-3 py-2">Entry</th>
                <th scope="col" className="px-3 py-2 text-right">In</th>
                <th scope="col" className="px-3 py-2 text-right">Out</th>
                <th scope="col" className="px-3 py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              <tr className="border-b border-[var(--gk-line)] bg-cream-50 text-ink-700">
                <td className="px-3 py-2">{dateLabel(from)}</td>
                <td className="px-3 py-2 font-semibold">Opening balance</td>
                <td />
                <td />
                <td className="px-3 py-2 text-right font-semibold">{formatPaise(book.openingPaise)}</td>
              </tr>
              {book.lines.map((l) => (
                <tr key={l.id} className="border-b border-[var(--gk-line)] last:border-b-0">
                  <td className="whitespace-nowrap px-3 py-2 text-ink-700">{dateLabel(l.entryDate)}</td>
                  <td className="px-3 py-2">
                    <span className="font-semibold text-ink-900">{VOUCHER_LABEL[l.voucherType] ?? l.voucherType}</span>
                    {l.docRef ? <span className="ml-1 text-ink-700">{l.docRef}</span> : null}
                    {entryText(l) ? <span className="block text-xs text-ink-600">{entryText(l)}</span> : null}
                  </td>
                  <td className="px-3 py-2 text-right text-green-800">{l.debitPaise ? formatPaise(l.debitPaise) : ""}</td>
                  <td className="px-3 py-2 text-right text-red-800">{l.creditPaise ? formatPaise(l.creditPaise) : ""}</td>
                  <td className="px-3 py-2 text-right font-semibold">{formatPaise(l.balancePaise ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

async function DayBook({ shopId, from, toExclusive }: { shopId: string; from: string; toExclusive: string }) {
  const vouchers = await dayBook(shopId, from, toExclusive);
  if (vouchers.length === 0) return <EmptyState title="No entries in these dates" />;
  return (
    <ol className="flex flex-col gap-2" aria-label="Day book">
      {vouchers.map((v) => (
        <li key={v.voucherId} className="rounded-2xl border border-[var(--gk-line)] bg-white p-2.5">
          <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-semibold text-ink-700 tabular-nums">{dateLabel(v.entryDate)}</span>
            <span className="font-bold text-ink-900">{VOUCHER_LABEL[v.voucherType] ?? v.voucherType}</span>
            {v.docRef ? <span className="text-ink-700">{v.docRef}</span> : null}
            {v.narration ? <span className="min-w-0 truncate text-xs text-ink-600">{v.narration}</span> : null}
          </div>
          <table className="w-full text-sm">
            <caption className="sr-only">Entries of this voucher</caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Debit</th>
                <th scope="col">Credit</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {v.legs.map((l) => (
                <tr key={l.id} className="border-t border-[var(--gk-line)]">
                  <td className={clsx("py-1", l.creditPaise ? "pl-6" : "pl-1")}>
                    {BOOK_ACCOUNT_LABELS[l.account as BookAccount] ?? l.account}
                    {l.partyName ? <span className="text-ink-600"> · {l.partyName}</span> : null}
                  </td>
                  <td className="w-28 py-1 text-right">{l.debitPaise ? `${formatPaise(l.debitPaise)} Dr` : ""}</td>
                  <td className="w-28 py-1 pr-1 text-right">{l.creditPaise ? `${formatPaise(l.creditPaise)} Cr` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </li>
      ))}
    </ol>
  );
}

async function Expenses({ shopId, from, toExclusive, today }: { shopId: string; from: string; toExclusive: string; today: string }) {
  const [expenses, parties] = await Promise.all([listExpenses(shopId, { from, to: toExclusive }), listParties(shopId, "ALL")]);
  const active = expenses.filter((e) => e.status === "ACTIVE");
  const total = active.reduce((n, e) => n + e.amountPaise, 0);
  const gst = active.reduce((n, e) => n + e.gstPaise, 0);
  const partyName = new Map(parties.map((p) => [p.id, p.name]));
  return (
    <>
      <Facts
        items={[
          { label: "Expenses", value: total, tone: "text-red-800" },
          { label: "GST you can claim", value: gst, tone: "text-violet-800" },
        ]}
      />
      <div className="mb-3">
        <AddExpenseForm shopId={shopId} today={today} parties={parties.map((p) => ({ id: p.id, name: p.name }))} />
      </div>
      {expenses.length === 0 ? (
        <EmptyState title="No expenses in these dates" description="Rent, electricity, salaries, transport — add them to see your true profit." />
      ) : (
        <ul className="overflow-hidden rounded-2xl border border-[var(--gk-line)] bg-white" aria-label="Expenses">
          {expenses.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 border-b border-[var(--gk-line)] px-3 py-2 last:border-b-0">
              <span className="w-14 shrink-0 text-sm text-ink-600 tabular-nums">{dateLabel(e.expenseDate)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold text-ink-900">{EXPENSE_CATEGORY_LABELS[e.category]}</span>
                <span className="block truncate text-xs text-ink-600">
                  {MODE_LABEL[e.mode] ?? e.mode}
                  {e.partyId && partyName.get(e.partyId) ? ` · ${partyName.get(e.partyId)}` : ""}
                  {e.gstPaise ? ` · GST ${formatPaise(e.gstPaise)}` : ""}
                  {e.description ? ` · ${e.description}` : ""}
                </span>
              </span>
              <span className={clsx("text-sm font-bold tabular-nums", e.status === "CANCELLED" ? "text-ink-500 line-through" : "text-ink-900")}>{formatPaise(e.amountPaise)}</span>
              {e.status === "CANCELLED" ? <Badge tone="danger">Cancelled</Badge> : <CancelEntryButton shopId={shopId} path={`expenses/${e.id}`} what="expense" />}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * docs/inventory-accounting-2026-10, Part 2: cash book, bank book, day book
 * and expenses for a date range (from and to both inclusive in the URL).
 */
export default async function MoneyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  const tab: Tab = TABS.some((t) => t.key === params.tab) ? (params.tab as Tab) : "cash";
  const today = todayIst();
  const monthStart = `${currentPeriod()}-01`;
  let from = typeof params.from === "string" && ISO.test(params.from) ? params.from : monthStart;
  let to = typeof params.to === "string" && ISO.test(params.to) ? params.to : today;
  if (to < from) [from, to] = [to, from];
  const toExclusive = addDays(to, 1);
  const tile = ACCOUNTS_TILES.find((t) => t.key === "money")!;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="money" shopQuery={shopQuery} />
      <AccountsHeader title={tr(tile.label, lang)} subtitle={`${shop.name} — ${dateLabel(from)} to ${dateLabel(to)}`} />

      <nav aria-label="Books" className="-mx-2 mb-2 flex gap-1.5 overflow-x-auto px-2 pb-1 [scrollbar-width:none]">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={href({ tab: t.key, from, to }, shopQuery)}
            aria-current={tab === t.key ? "page" : undefined}
            className={clsx("flex min-h-11 shrink-0 items-center rounded-xl px-3 text-sm font-semibold", tab === t.key ? "bg-green-700 text-white" : "border border-[var(--gk-line)] bg-white text-ink-900 hover:bg-green-50")}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <form method="get" action="/shop/accounts/money" className="mb-3 flex flex-wrap items-end gap-1.5">
        <input type="hidden" name="tab" value={tab} />
        {shopQuery ? <input type="hidden" name="shop" value={shop.id} /> : null}
        <label className="flex flex-col text-xs font-semibold text-ink-600">
          From
          <input type="date" name="from" defaultValue={from} max={today} className="min-h-11 rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-normal text-ink-900" />
        </label>
        <label className="flex flex-col text-xs font-semibold text-ink-600">
          To
          <input type="date" name="to" defaultValue={to} className="min-h-11 rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-normal text-ink-900" />
        </label>
        <button type="submit" className="min-h-11 rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-semibold hover:bg-green-50">
          Show
        </button>
        <Link href={href({ tab, from: today, to: today }, shopQuery)} className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold text-kesari-700 hover:underline">
          Today
        </Link>
        <Link href={href({ tab, from: monthStart, to: today }, shopQuery)} className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold text-kesari-700 hover:underline">
          This month
        </Link>
      </form>

      {tab === "cash" ? <Book shopId={shop.id} account="CASH" from={from} toExclusive={toExclusive} /> : null}
      {tab === "bank" ? <Book shopId={shop.id} account="BANK" from={from} toExclusive={toExclusive} /> : null}
      {tab === "day" ? <DayBook shopId={shop.id} from={from} toExclusive={toExclusive} /> : null}
      {tab === "expenses" ? <Expenses shopId={shop.id} from={from} toExclusive={toExclusive} today={today} /> : null}
    </div>
  );
}
