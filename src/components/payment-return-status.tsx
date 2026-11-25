"use client";

/**
 * After the payment page (batch-2026-10 WS-A): polls the payment until the
 * gateway has answered, then shows paid / failed / not completed. A failed or
 * expired payment offers "Retry payment", which reuses the same order.
 * Everything shown comes from the server; nothing here decides the status.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Alert, Button, Money } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Wording (Module 6, docs/hindi-marathi-2026-11/). The gateway's failure reason stays as sent. */
const T = {
  retryFailed: L("Could not start the payment again.", "भुगतान फिर से शुरू नहीं हो सका।", "पेमेंट पुन्हा सुरू करता आले नाही."),
  receivedTitle: L("Payment received", "भुगतान मिल गया", "पेमेंट मिळाले"),
  receivedText: L("Your order is placed and paid.", "आपका ऑर्डर हो गया है और भुगतान हो गया है।", "तुमची ऑर्डर दिली गेली असून पेमेंट झाले आहे."),
  refunded: L(
    "has been refunded to your original payment method.",
    "आपके मूल भुगतान तरीके में वापस भेज दिए गए हैं।",
    "तुमच्या मूळ पेमेंट पद्धतीत परत पाठवले आहेत.",
  ),
  failedTitle: L("Payment failed", "भुगतान असफल", "पेमेंट अयशस्वी"),
  expiredTitle: L("Payment not completed in time", "समय पर भुगतान पूरा नहीं हुआ", "वेळेत पेमेंट पूर्ण झाले नाही"),
  notCharged: L(
    "You have not been charged for this attempt. Your order is kept — you can pay again.",
    "इस कोशिश के लिए आपसे पैसे नहीं कटे। आपका ऑर्डर सुरक्षित है — आप फिर से भुगतान कर सकते हैं।",
    "या प्रयत्नासाठी तुमचे पैसे कापले गेले नाहीत. तुमची ऑर्डर ठेवली आहे — तुम्ही पुन्हा पेमेंट करू शकता.",
  ),
  waitingTitle: L("Waiting for the payment result", "भुगतान के नतीजे का इंतज़ार", "पेमेंटच्या निकालाची वाट पाहत आहोत"),
  slow: L(
    "This is taking longer than usual. If money left your account, it will be matched to your order automatically — check your orders in a few minutes.",
    "इसमें सामान्य से ज़्यादा समय लग रहा है। अगर आपके खाते से पैसे कटे हैं, तो वे अपने आप आपके ऑर्डर से जुड़ जाएँगे — कुछ मिनट बाद अपने ऑर्डर देखें।",
    "याला नेहमीपेक्षा जास्त वेळ लागत आहे. तुमच्या खात्यातून पैसे गेले असतील, तर ते आपोआप तुमच्या ऑर्डरशी जोडले जातील — काही मिनिटांनी तुमच्या ऑर्डर पहा.",
  ),
  usual: L(
    "This usually takes a few seconds. Please keep this page open.",
    "इसमें आमतौर पर कुछ सेकंड लगते हैं। कृपया यह पेज खुला रखें।",
    "याला साधारण काही सेकंद लागतात. कृपया हे पान उघडे ठेवा.",
  ),
  starting: L("Starting…", "शुरू हो रहा है…", "सुरू होत आहे…"),
  retry: L("Retry payment", "फिर से भुगतान करें", "पुन्हा पेमेंट करा"),
  back: L("Back to the payment page", "भुगतान पेज पर वापस", "पेमेंट पानावर परत"),
  myOrders: L("My orders", "मेरे ऑर्डर", "माझ्या ऑर्डर"),
} as const;

interface StatusView {
  intentId: string;
  status: string;
  amountPaise: number;
  refundedPaise: number;
  reference: string;
  failureReason: string | null;
  redirectUrl: string | null;
  canRetry: boolean;
  orders: { id: string; orderNumber: string; status: string }[];
}

const POLL_MS = 3000;
const MAX_POLLS = 60;

export function PaymentReturnStatus({ intentId, initial, lang = "en" }: { intentId: string; initial: StatusView; lang?: Lang }) {
  const router = useRouter();
  const [view, setView] = useState<StatusView>(initial);
  const [polls, setPolls] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = ["CREATED", "PENDING", "AUTHORIZED"].includes(view.status);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/payments/intents/${intentId}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload) setView(payload as StatusView);
  }, [intentId]);

  useEffect(() => {
    if (!open || polls >= MAX_POLLS) return;
    const timer = setTimeout(() => {
      void refresh().finally(() => setPolls((n) => n + 1));
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [open, polls, refresh]);

  async function retry() {
    const orderId = view.orders.find((o) => o.status === "PAYMENT_FAILED")?.id;
    if (!orderId) return;
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/orders/${orderId}/pay`, { method: "POST" });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    if (!response.ok) {
      setError(payload?.error?.message ? errorText(payload.error.message, lang, payload.error.code) : tr(T.retryFailed, lang));
      return;
    }
    if (payload?.redirectUrl) window.location.assign(payload.redirectUrl);
    else if (payload?.intentId) router.push(`/orders/payment-return?intent=${payload.intentId}`);
  }

  const orderList = (
    <ul className="mt-2 space-y-1 text-sm">
      {view.orders.map((o) => (
        <li key={o.id}>
          <Link href={`/orders/${o.id}`} className="font-medium underline">
            {o.orderNumber}
          </Link>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="space-y-4" data-testid="payment-return" data-status={view.status}>
      <div>
        <p className="text-sm text-ink-600">{view.reference}</p>
        <p className="mt-1 text-2xl font-semibold text-ink-900">
          <Money paise={view.amountPaise} />
        </p>
      </div>

      {view.status === "CAPTURED" || view.status === "PARTIALLY_REFUNDED" || view.status === "REFUNDED" ? (
        <Alert tone="success" title={tr(T.receivedTitle, lang)}>
          {tr(T.receivedText, lang)}
          {view.refundedPaise > 0 ? (
            <>
              {" "}
              <Money paise={view.refundedPaise} /> {tr(T.refunded, lang)}
            </>
          ) : null}
          {orderList}
        </Alert>
      ) : null}

      {view.status === "FAILED" || view.status === "EXPIRED" ? (
        <Alert tone="danger" title={tr(view.status === "FAILED" ? T.failedTitle : T.expiredTitle, lang)}>
          {view.failureReason && view.status === "FAILED" ? `${view.failureReason}. ` : ""}
          {tr(T.notCharged, lang)}
          {orderList}
        </Alert>
      ) : null}

      {open ? (
        <Alert tone="info" title={tr(T.waitingTitle, lang)}>
          {tr(polls >= MAX_POLLS ? T.slow : T.usual, lang)}
        </Alert>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex flex-wrap gap-2">
        {view.canRetry ? (
          <Button onClick={() => void retry()} disabled={busy} data-testid="retry-payment">
            {tr(busy ? T.starting : T.retry, lang)}
          </Button>
        ) : null}
        {open && view.redirectUrl ? (
          <Button variant="secondary" onClick={() => window.location.assign(view.redirectUrl!)}>
            {tr(T.back, lang)}
          </Button>
        ) : null}
        <Link href="/orders" className="inline-flex min-h-11 items-center px-2 text-sm underline">
          {tr(T.myOrders, lang)}
        </Link>
      </div>
    </div>
  );
}
