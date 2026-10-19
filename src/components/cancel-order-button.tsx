"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card } from "@/components/ui";
import { formatPaise } from "@/lib/money";

interface Line {
  code: string;
  label: string;
  amountPaise: number;
  note?: string;
}

interface Quote {
  allowed: boolean;
  blockedReason: string | null;
  breakdown: {
    paid: boolean;
    paidPaise: number;
    paidLines: Line[];
    deductions: Line[];
    deductionsPaise: number;
    refundPaise: number;
  };
  refundMethods: { method: "WALLET" | "ORIGINAL"; label: string; detail: string }[];
  defaultMethod: "WALLET" | "ORIGINAL" | null;
}

/**
 * "Cancel order" on My Orders and the order page. First shows what
 * cancelling now means — what was paid, any fee kept and why, what comes back
 * and where it can go (batch-2026-10 WS-C, F6.1.3 / F6.2.3) — and only then
 * asks to confirm. The server checks everything again, including that the
 * refund is still the amount shown.
 */
export function CancelOrderButton({ orderId, orderNumber }: { orderId: string; orderNumber: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [method, setMethod] = useState<"WALLET" | "ORIGINAL" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function loadQuote() {
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/orders/${orderId}/cancellation-quote`, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    if (!response.ok) {
      setMessage({ ok: false, text: payload?.error?.message ?? "Could not check this order. Please try again." });
      return;
    }
    setQuote(payload as Quote);
    setMethod((payload as Quote).defaultMethod);
  }

  async function cancel() {
    if (!quote) return;
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/orders/${orderId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "Cancelled by the customer from My Orders",
        refundMethod: method ?? undefined,
        expectedRefundPaise: quote.breakdown.paid ? quote.breakdown.refundPaise : undefined,
      }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    if (!response.ok) {
      setMessage({ ok: false, text: payload?.error?.message ?? "Could not cancel this order. Please try again or contact the shop." });
      // The amount may have changed: show the new figures.
      if (response.status === 409) void loadQuote();
      return;
    }
    const fullToWallet = quote.breakdown.deductionsPaise === 0 && (method ?? "WALLET") === "WALLET";
    router.push(fullToWallet ? `/orders?tab=past&cancelled=${encodeURIComponent(orderNumber)}` : `/orders/${orderId}?cancelled=1`);
  }

  if (!quote) {
    return (
      <div className="mt-3 flex flex-col gap-2" data-testid="cancel-order">
        <div>
          <Button size="sm" variant="danger" disabled={busy} onClick={loadQuote}>
            {busy ? "Checking…" : "Cancel order"}
          </Button>
        </div>
        {message ? (
          <p role="alert" className="text-sm font-medium text-red-700">
            {message.text}
          </p>
        ) : null}
      </div>
    );
  }

  const { breakdown } = quote;
  return (
    <Card className="mt-3 space-y-3 p-4" data-testid="cancel-order-quote">
      <p className="text-sm font-semibold text-ink-900">Cancel order {orderNumber}?</p>
      {!quote.allowed ? (
        <Alert tone="warning">{quote.blockedReason}</Alert>
      ) : (
        <>
          {breakdown.paid ? (
            <dl className="space-y-1 text-sm" aria-label="Refund breakdown">
              {breakdown.paidLines.map((l) => (
                <div key={l.code} className="flex justify-between gap-3 text-ink-600">
                  <dt>{l.label}</dt>
                  <dd className="tabular-nums">{formatPaise(l.amountPaise)}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-3 border-t border-cream-100 pt-1 font-medium text-ink-900">
                <dt>You paid</dt>
                <dd className="tabular-nums">{formatPaise(breakdown.paidPaise)}</dd>
              </div>
              {breakdown.deductions.map((d) => (
                <div key={d.code} className="flex justify-between gap-3 text-red-700">
                  <dt>
                    {d.label}
                    {d.note ? <span className="block text-xs text-ink-500">{d.note}</span> : null}
                  </dt>
                  <dd className="tabular-nums">−{formatPaise(d.amountPaise)}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-3 border-t border-cream-100 pt-1 text-base font-semibold text-ink-900">
                <dt>Refund</dt>
                <dd className="tabular-nums" data-testid="refund-amount">
                  {formatPaise(breakdown.refundPaise)}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-ink-600">Nothing has been paid for this order yet, so there is nothing to refund.</p>
          )}
          {quote.refundMethods.length > 1 ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-ink-700">Where should the refund go?</legend>
              {quote.refundMethods.map((m) => (
                <label key={m.method} className="flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border border-cream-200 p-2 text-sm">
                  <input
                    type="radio"
                    name={`refund-${orderId}`}
                    className="mt-1"
                    checked={method === m.method}
                    onChange={() => setMethod(m.method)}
                  />
                  <span>
                    <span className="font-medium text-ink-900">{m.label}</span>
                    <span className="block text-xs text-ink-500">{m.detail}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : quote.refundMethods.length === 1 && breakdown.refundPaise > 0 ? (
            <p className="text-sm text-ink-600">
              The refund goes to your {quote.refundMethods[0].label} — {quote.refundMethods[0].detail.toLowerCase()}
            </p>
          ) : null}
        </>
      )}
      {message ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {message.text}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {quote.allowed ? (
          <Button size="sm" variant="danger" disabled={busy} onClick={cancel}>
            {busy ? "Cancelling…" : "Yes, cancel order"}
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setQuote(null)}>
          Keep order
        </Button>
      </div>
    </Card>
  );
}
