"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { formatPaiseCompact, lineTotalPaise, MILLI_PER_UNIT } from "@/lib/money";
import type { TomorrowLine } from "@/server/services/tomorrow-delivery";

/** "1 L", "0.5 kg", "2 pc". */
function quantityText(milli: number, unit: string): string {
  return `${milli / MILLI_PER_UNIT} ${unit === "piece" ? "pc" : unit}`;
}

const linePrice = (line: TomorrowLine, quantityMilli: number) =>
  line.unitPricePaise ? lineTotalPaise(line.unitPricePaise, quantityMilli) : 0;

/**
 * "Tomorrow's delivery" on the home page (requirement §29): what the
 * customer's subscriptions bring tomorrow, with − / + on each line, one
 * button to skip the day, and a warning when the wallet will not cover what
 * is coming.
 *
 * Each tap is saved at once through the same per-date override and skip
 * endpoints the subscription page uses, so the standing subscription is never
 * changed from here. Quantities stay in milli-units end to end.
 */
export function TomorrowDeliveryCard({
  date,
  dateLabel,
  lines: initialLines,
  walletBalancePaise,
  cutoffLabel,
  beforeCutoff,
  following,
}: {
  /** Tomorrow as YYYY-MM-DD — the date every change applies to. */
  date: string;
  /** "Thu 8 Oct". */
  dateLabel: string;
  lines: TomorrowLine[];
  walletBalancePaise: number;
  /** "8:00 PM". */
  cutoffLabel: string;
  beforeCutoff: boolean;
  /** The next delivery day after tomorrow: its weekday name and cost. */
  following: { dayName: string; costPaise: number } | null;
}) {
  const router = useRouter();
  const [lines, setLines] = useState(initialLines);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The server's copy replaces local state whenever it changes (after a
  // refresh), so the card never drifts from what is saved.
  const [seen, setSeen] = useState(initialLines);
  if (seen !== initialLines) {
    setSeen(initialLines);
    setLines(initialLines);
  }

  const active = lines.filter((l) => !l.skipped);
  const totalPaise = active.reduce((sum, l) => sum + linePrice(l, l.quantityMilli), 0);
  const allLocked = lines.every((l) => l.locked);
  const skippable = lines.filter((l) => !l.skipped && !l.locked);
  const restorable = lines.filter((l) => l.skipped && !l.locked);

  async function call(subscriptionId: string, path: "override" | "skip", method: "POST" | "DELETE", body: object) {
    const response = await fetch(`/api/subscriptions/${subscriptionId}/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error?.message ?? "Could not save the change.");
    }
  }

  /** Runs a change, showing it at once and putting things back if it fails. */
  async function apply(next: TomorrowLine[], work: () => Promise<void>) {
    const previous = lines;
    setLines(next);
    setBusy(true);
    setError(null);
    try {
      await work();
      router.refresh();
    } catch (caught) {
      setLines(previous);
      setError(caught instanceof Error ? caught.message : "Could not save the change.");
    } finally {
      setBusy(false);
    }
  }

  function changeQuantity(line: TomorrowLine, deltaMilli: number) {
    const quantityMilli = line.quantityMilli + deltaMilli;
    if (quantityMilli < line.stepMilli) return;
    void apply(
      lines.map((l) => (l.subscriptionId === line.subscriptionId ? { ...l, quantityMilli } : l)),
      // Back at the standing quantity: drop the override instead of storing a no-op.
      () =>
        quantityMilli === line.standingQuantityMilli
          ? call(line.subscriptionId, "override", "DELETE", { date })
          : call(line.subscriptionId, "override", "POST", { date, quantityMilli }),
    );
  }

  function skipTomorrow() {
    void apply(
      lines.map((l) => (l.locked ? l : { ...l, skipped: true })),
      async () => {
        for (const line of skippable) await call(line.subscriptionId, "skip", "POST", { date });
      },
    );
  }

  function undoSkip() {
    void apply(
      lines.map((l) => (l.locked ? l : { ...l, skipped: false, quantityMilli: l.standingQuantityMilli })),
      async () => {
        for (const line of restorable) await call(line.subscriptionId, "override", "DELETE", { date });
      },
    );
  }

  // Wallet check: tomorrow first, then the delivery day after it.
  const shortTomorrow = totalPaise > 0 && walletBalancePaise < totalPaise;
  const shortFollowing =
    !shortTomorrow && totalPaise > 0 && following != null && walletBalancePaise - totalPaise < following.costPaise;

  return (
    <section
      aria-labelledby="tomorrow-delivery-title"
      className="rounded-2xl border border-cream-200 bg-white p-4 shadow-sm sm:p-5"
      data-testid="tomorrow-delivery"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="tomorrow-delivery-title" className="text-lg font-semibold text-ink-900">
            Tomorrow&apos;s delivery
          </h2>
          <p className="text-sm text-ink-500" data-testid="tomorrow-date">
            {dateLabel}
          </p>
        </div>
        <p
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
            allLocked ? "bg-slate-100 text-ink-600" : "bg-leaf-50 text-leaf-700"
          }`}
        >
          <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden>
            <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10 5.8V10l2.8 1.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          {allLocked
            ? "Confirmed for tomorrow"
            : beforeCutoff
              ? `Change or skip until ${cutoffLabel}`
              : "You can still change or skip"}
        </p>
      </div>

      <ul className="mt-3 space-y-2">
        {lines.map((line) => (
          <li
            key={line.subscriptionId}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-cream-200 px-3 py-2.5"
          >
            <div className="min-w-0 flex-1 basis-40">
              <Link
                href={`/subscriptions/${line.subscriptionId}`}
                className={`block truncate text-sm font-semibold hover:underline ${line.skipped ? "text-ink-500 line-through" : "text-ink-900"}`}
              >
                {line.productName}
              </Link>
              <p className="truncate text-xs text-ink-500">
                {line.shopName} · {line.scheduleLabel}
              </p>
            </div>

            {line.skipped ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">Skipped</span>
            ) : line.locked ? (
              <span className="text-sm font-medium tabular-nums text-ink-700">{quantityText(line.quantityMilli, line.unit)}</span>
            ) : (
              <div className="flex items-center overflow-hidden rounded-lg border border-kesari-300">
                <button
                  type="button"
                  disabled={busy || line.quantityMilli <= line.stepMilli}
                  onClick={() => changeQuantity(line, -line.stepMilli)}
                  aria-label={`Less ${line.productName}`}
                  className="tap-target grid h-9 w-9 place-items-center bg-kesari-50 text-lg text-kesari-700 hover:bg-kesari-100 disabled:text-kesari-300 [--tap-h:44px] [--tap-w:40px]"
                >
                  −
                </button>
                <span className="min-w-14 px-2 text-center text-sm font-medium tabular-nums text-ink-900" aria-live="polite">
                  {quantityText(line.quantityMilli, line.unit)}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => changeQuantity(line, line.stepMilli)}
                  aria-label={`More ${line.productName}`}
                  className="tap-target grid h-9 w-9 place-items-center bg-kesari-50 text-lg text-kesari-700 hover:bg-kesari-100 disabled:text-kesari-300 [--tap-h:44px] [--tap-w:40px]"
                >
                  +
                </button>
              </div>
            )}

            <span className="ml-auto w-14 text-right text-sm font-semibold tabular-nums text-ink-900">
              {line.skipped ? "—" : formatPaiseCompact(linePrice(line, line.quantityMilli))}
            </span>
          </li>
        ))}
      </ul>

      {error ? (
        <p role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-cream-200 pt-3">
        <p className="text-sm text-ink-500">
          Total{" "}
          <span className="text-lg font-bold tabular-nums text-ink-900" data-testid="tomorrow-total">
            {formatPaiseCompact(totalPaise)}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          {skippable.length > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={skipTomorrow}
              className="tap-target rounded-lg border border-cream-200 bg-white px-3 py-2 text-sm font-medium text-ink-700 hover:bg-cream-100 disabled:text-ink-400"
            >
              Skip tomorrow
            </button>
          ) : restorable.length > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={undoSkip}
              className="tap-target rounded-lg border border-cream-200 bg-white px-3 py-2 text-sm font-medium text-ink-700 hover:bg-cream-100 disabled:text-ink-400"
            >
              Undo skip
            </button>
          ) : null}
          <Link
            href="/subscriptions"
            className="tap-target rounded-lg bg-kesari-600 px-3 py-2 text-sm font-medium text-white hover:bg-kesari-800"
          >
            My subscriptions
          </Link>
        </div>
      </div>

      {shortTomorrow || shortFollowing ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-kesari-300 bg-kesari-50 px-3 py-2.5" data-testid="wallet-warning">
          <p className="min-w-0 flex-1 basis-48 text-sm text-kesari-800">
            <strong className="font-semibold">Wallet {formatPaiseCompact(walletBalancePaise)}.</strong>{" "}
            {shortTomorrow
              ? `That does not cover tomorrow's ${formatPaiseCompact(totalPaise)}. Top up so tomorrow is not missed.`
              : `That covers tomorrow only. Top up so ${following!.dayName} is not missed.`}
          </p>
          <Link
            href="/wallet"
            className="tap-target rounded-lg bg-kesari-800 px-3 py-2 text-sm font-medium text-white hover:bg-kesari-700"
          >
            Top up
          </Link>
        </div>
      ) : null}
    </section>
  );
}
