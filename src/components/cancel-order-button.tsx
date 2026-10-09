"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfirmButton } from "@/components/confirm-button";

/**
 * "Cancel order" on My Orders, for an order the shop has not started packing
 * — the same request and rule as the cart's open-order cancel (the server
 * checks again and refunds to the wallet). Asks once before it acts.
 */
export function CancelOrderButton({ orderId, orderNumber }: { orderId: string; orderNumber: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function cancel() {
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/orders/${orderId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "CANCELLED", note: "Cancelled by the customer from My Orders" }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    if (!response.ok) {
      setMessage({ ok: false, text: payload?.error?.message ?? "Could not cancel this order. Please try again or contact the shop." });
      return;
    }
    // The order leaves "Active": show it under "Past" with the result.
    router.push(`/orders?tab=past&cancelled=${encodeURIComponent(orderNumber)}`);
  }

  return (
    <div className="mt-3 flex flex-col gap-2" data-testid="cancel-order">
      <ConfirmButton onConfirm={cancel} disabled={busy} confirmLabel="Yes, cancel order" keepLabel="Keep order" question="Cancel this order?">
        {busy ? "Cancelling…" : "Cancel order"}
      </ConfirmButton>
      {message ? (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm font-medium text-green-800" : "text-sm font-medium text-red-700"}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
