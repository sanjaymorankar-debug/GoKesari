"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { formatPaise } from "@/lib/money";

interface Quote {
  amountPaise: number;
  feePaise: number;
  tdsPaise: number;
  tdsRateBp: number;
  netPaise: number;
  settlement: string;
  account: string | null;
  problem: string | null;
}

/**
 * Withdraw unpaid earnings to the verified bank account
 * (docs/gig-bank-payouts-2026-10): amount → what will be paid (fee, TDS,
 * settlement time) → emailed code → withdraw.
 */
export function WithdrawPanel({ availablePaise, minPaise, maxPaise, leftTodayPaise }: { availablePaise: number; minPaise: number; maxPaise: number; leftTodayPaise: number }) {
  const router = useRouter();
  const [rupees, setRupees] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const amountPaise = Math.round(Number(rupees.replace(/,/g, "")) * 100);
  const upTo = Math.min(availablePaise, maxPaise, leftTodayPaise);

  async function call(url: string, init?: RequestInit) {
    const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message ?? "Something went wrong.");
    return payload;
  }

  async function check(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    setCodeSentTo(null);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) return setError("Enter the amount to withdraw.");
    setBusy(true);
    try {
      setQuote(await call(`/api/gig/wallet/quote?amountPaise=${amountPaise}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not check the amount.");
    } finally {
      setBusy(false);
    }
  }

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      const payload = await call("/api/gig/wallet/withdrawals", { method: "POST", body: JSON.stringify({ amountPaise }) });
      setCodeSentTo(payload.codeSent?.maskedEmail ?? "your email");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the code.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const transfer = await call("/api/gig/wallet/withdrawals", { method: "POST", body: JSON.stringify({ amountPaise, code }) });
      setDone(
        transfer.status === "SUCCESS"
          ? `${formatPaise(transfer.netPaise)} has been paid to your bank.`
          : transfer.status === "RELEASED"
            ? `The bank refused the transfer: ${transfer.failureReason ?? ""} The amount is back in your balance.`
            : `${formatPaise(transfer.netPaise)} is on its way to your bank.`,
      );
      setQuote(null);
      setCodeSentTo(null);
      setCode("");
      setRupees("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not withdraw.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <form onSubmit={check} className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <Field label="Amount (₹)" hint={`Between ${formatPaise(minPaise)} and ${formatPaise(upTo > 0 ? upTo : 0)} today.`}>
            <input
              className={inputClass}
              inputMode="decimal"
              value={rupees}
              onChange={(e) => {
                setRupees(e.target.value);
                setQuote(null);
                setCodeSentTo(null);
              }}
              placeholder="500"
              aria-label="Amount to withdraw in rupees"
            />
          </Field>
        </div>
        <Button type="submit" variant="secondary" disabled={busy || !rupees}>
          Check
        </Button>
      </form>

      {quote ? (
        <div className="rounded-lg border border-cream-200 p-4 text-sm">
          <dl className="grid grid-cols-2 gap-y-1">
            <dt className="text-ink-500">Amount</dt>
            <dd className="text-right">{formatPaise(quote.amountPaise)}</dd>
            <dt className="text-ink-500">Fee</dt>
            <dd className="text-right">{quote.feePaise > 0 ? `− ${formatPaise(quote.feePaise)}` : "None"}</dd>
            <dt className="text-ink-500">TDS {quote.tdsRateBp > 0 ? `(${quote.tdsRateBp / 100}%)` : ""}</dt>
            <dd className="text-right">{quote.tdsPaise > 0 ? `− ${formatPaise(quote.tdsPaise)}` : "None"}</dd>
            <dt className="font-semibold text-ink-900">You receive</dt>
            <dd className="text-right font-semibold text-ink-900">{formatPaise(quote.netPaise)}</dd>
          </dl>
          <p className="mt-3 text-ink-500">
            To {quote.account ?? "your bank account"} — {quote.settlement}.
          </p>
          {quote.problem ? (
            <div className="mt-3">
              <Alert tone="warning">{quote.problem}</Alert>
            </div>
          ) : codeSentTo ? (
            <form onSubmit={confirm} className="mt-3 flex flex-wrap items-end gap-3">
              <div className="min-w-[10rem] flex-1">
                <Field label="Code" hint={`We emailed a code to ${codeSentTo}.`}>
                  <input className={inputClass} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Confirmation code" />
                </Field>
              </div>
              <Button type="submit" disabled={busy || code.trim().length < 4}>
                Withdraw {formatPaise(quote.netPaise)}
              </Button>
            </form>
          ) : (
            <div className="mt-3">
              <Button onClick={sendCode} disabled={busy}>
                Email me a code to confirm
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {done ? <Alert tone="success">{done}</Alert> : null}
    </Card>
  );
}
