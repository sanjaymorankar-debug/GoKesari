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

export function PaymentReturnStatus({ intentId, initial }: { intentId: string; initial: StatusView }) {
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
      setError(payload?.error?.message ?? "Could not start the payment again.");
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
        <Alert tone="success" title="Payment received">
          Your order is placed and paid.
          {view.refundedPaise > 0 ? (
            <>
              {" "}
              <Money paise={view.refundedPaise} /> has been refunded to your original payment method.
            </>
          ) : null}
          {orderList}
        </Alert>
      ) : null}

      {view.status === "FAILED" || view.status === "EXPIRED" ? (
        <Alert tone="danger" title={view.status === "FAILED" ? "Payment failed" : "Payment not completed in time"}>
          {view.failureReason && view.status === "FAILED" ? `${view.failureReason}. ` : ""}
          You have not been charged for this attempt. Your order is kept — you can pay again.
          {orderList}
        </Alert>
      ) : null}

      {open ? (
        <Alert tone="info" title="Waiting for the payment result">
          {polls >= MAX_POLLS
            ? "This is taking longer than usual. If money left your account, it will be matched to your order automatically — check your orders in a few minutes."
            : "This usually takes a few seconds. Please keep this page open."}
        </Alert>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex flex-wrap gap-2">
        {view.canRetry ? (
          <Button onClick={() => void retry()} disabled={busy} data-testid="retry-payment">
            {busy ? "Starting…" : "Retry payment"}
          </Button>
        ) : null}
        {open && view.redirectUrl ? (
          <Button variant="secondary" onClick={() => window.location.assign(view.redirectUrl!)}>
            Back to the payment page
          </Button>
        ) : null}
        <Link href="/orders" className="inline-flex min-h-11 items-center px-2 text-sm underline">
          My orders
        </Link>
      </div>
    </div>
  );
}
