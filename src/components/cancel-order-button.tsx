"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";
import { formatPaise } from "@/lib/money";

/** Wording (Module 6, docs/hindi-marathi-2026-11/). Fee and refund lines come from the server in English. */
const T = {
  checkFailed: L("Could not check this order. Please try again.", "इस ऑर्डर की जाँच नहीं हो सकी। फिर कोशिश करें।", "या ऑर्डरची तपासणी करता आली नाही. पुन्हा प्रयत्न करा."),
  cancelFailed: L(
    "Could not cancel this order. Please try again or contact the shop.",
    "यह ऑर्डर रद्द नहीं हो सका। फिर कोशिश करें या दुकान से संपर्क करें।",
    "ही ऑर्डर रद्द करता आली नाही. पुन्हा प्रयत्न करा किंवा दुकानाशी संपर्क करा.",
  ),
  checking: L("Checking…", "जाँच हो रही है…", "तपासत आहे…"),
  cancelOrder: L("Cancel order", "ऑर्डर रद्द करें", "ऑर्डर रद्द करा"),
  confirmTitle: L("Cancel order {n}?", "ऑर्डर {n} रद्द करें?", "ऑर्डर {n} रद्द करायची?"),
  breakdown: L("Refund breakdown", "रिफंड का ब्योरा", "परताव्याचा तपशील"),
  youPaid: L("You paid", "आपने भुगतान किया", "तुम्ही भरले"),
  refund: L("Refund", "रिफंड", "परतावा"),
  nothingPaid: L(
    "Nothing has been paid for this order yet, so there is nothing to refund.",
    "इस ऑर्डर का अभी कोई भुगतान नहीं हुआ है, इसलिए रिफंड के लिए कुछ नहीं है।",
    "या ऑर्डरचे अजून कोणतेही पेमेंट झालेले नाही, त्यामुळे परत करण्यासारखे काही नाही.",
  ),
  where: L("Where should the refund go?", "रिफंड कहाँ भेजें?", "परतावा कुठे पाठवायचा?"),
  goesTo: L("The refund goes to your", "रिफंड यहाँ जाएगा:", "परतावा येथे जाईल:"),
  cancelling: L("Cancelling…", "रद्द हो रहा है…", "रद्द होत आहे…"),
  yesCancel: L("Yes, cancel order", "हाँ, ऑर्डर रद्द करें", "होय, ऑर्डर रद्द करा"),
  keep: L("Keep order", "ऑर्डर रखें", "ऑर्डर ठेवा"),
} as const;

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
export function CancelOrderButton({ orderId, orderNumber, lang = "en" }: { orderId: string; orderNumber: string; lang?: Lang }) {
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
      setMessage({ ok: false, text: payload?.error?.message ? errorText(payload.error.message, lang, payload.error.code) : tr(T.checkFailed, lang) });
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
      setMessage({ ok: false, text: payload?.error?.message ? errorText(payload.error.message, lang, payload.error.code) : tr(T.cancelFailed, lang) });
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
            {tr(busy ? T.checking : T.cancelOrder, lang)}
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
      <p className="text-sm font-semibold text-ink-900">{tr(T.confirmTitle, lang).replace("{n}", orderNumber)}</p>
      {!quote.allowed ? (
        <Alert tone="warning">{quote.blockedReason}</Alert>
      ) : (
        <>
          {breakdown.paid ? (
            <dl className="space-y-1 text-sm" aria-label={tr(T.breakdown, lang)}>
              {breakdown.paidLines.map((l) => (
                <div key={l.code} className="flex justify-between gap-3 text-ink-600">
                  <dt>{l.label}</dt>
                  <dd className="tabular-nums">{formatPaise(l.amountPaise)}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-3 border-t border-cream-100 pt-1 font-medium text-ink-900">
                <dt>{tr(T.youPaid, lang)}</dt>
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
                <dt>{tr(T.refund, lang)}</dt>
                <dd className="tabular-nums" data-testid="refund-amount">
                  {formatPaise(breakdown.refundPaise)}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-ink-600">{tr(T.nothingPaid, lang)}</p>
          )}
          {quote.refundMethods.length > 1 ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-ink-700">{tr(T.where, lang)}</legend>
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
              {tr(T.goesTo, lang)} {quote.refundMethods[0].label} — {quote.refundMethods[0].detail.toLowerCase()}
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
            {tr(busy ? T.cancelling : T.yesCancel, lang)}
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setQuote(null)}>
          {tr(T.keep, lang)}
        </Button>
      </div>
    </Card>
  );
}
