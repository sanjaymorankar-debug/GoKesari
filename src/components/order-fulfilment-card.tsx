"use client";

import { useState } from "react";

import { Button } from "@/components/ui";

/** services/fulfilment-options.ts BuyerFulfilmentView, as the customer's order card shows it. */
export interface OrderFulfilmentInfo {
  option: "PICKUP" | "SHOP_DELIVERY" | "GOKESARI_PARTNER";
  optionLabel: string;
  whenLabel: string;
  staffName: string | null;
  shopAddress: string | null;
  pickupCode: string | null;
  deliveryCode: { active: boolean; locked: boolean; resendsLeft: number; maskedEmail: string } | null;
  completed: boolean;
  updated: boolean;
}

/**
 * Fulfilment options (docs/four-features-2026-10) on the customer's order:
 * how and when the order arrives, the pickup code to show at the shop, and
 * the delivery code for the shop's own delivery person.
 */
export function OrderFulfilmentCard({ orderId, info }: { orderId: string; info: OrderFulfilmentInfo }) {
  return (
    <div className="mt-3 rounded-lg border border-kesari-100 bg-kesari-50 px-3 py-2 text-sm text-ink-800" data-testid="order-fulfilment">
      <p>
        <span className="font-medium">{info.optionLabel}</span>
        {info.staffName ? ` · ${info.staffName}` : ""} · {info.whenLabel}
        {info.updated && !info.completed ? <span className="ml-1 text-xs text-kesari-700">(updated)</span> : null}
      </p>
      {info.option === "PICKUP" && info.shopAddress && !info.completed ? (
        <p className="mt-0.5 text-xs text-ink-600">Collect from: {info.shopAddress}</p>
      ) : null}
      {info.pickupCode ? (
        <p className="mt-2" data-testid="pickup-code-customer">
          Pickup code: <span className="font-mono text-lg font-bold tracking-widest">{info.pickupCode}</span>
          <span className="block text-xs text-ink-600">Show this at the shop when you collect your order — not before.</span>
        </p>
      ) : null}
      {info.deliveryCode ? <OwnDeliveryCode orderId={orderId} state={info.deliveryCode} /> : null}
    </div>
  );
}

function OwnDeliveryCode({ orderId, state }: { orderId: string; state: NonNullable<OrderFulfilmentInfo["deliveryCode"]> }) {
  const [code, setCode] = useState<string | null>(null);
  const [left, setLeft] = useState(state.resendsLeft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.locked) {
    return (
      <p className="mt-2 text-sm text-amber-900" data-testid="own-delivery-code-locked">
        Too many wrong delivery codes were entered, so this delivery is on hold. Our support team will contact you.
      </p>
    );
  }

  async function newCode() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/orders/${orderId}/fulfilment-plan/code`, { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "Could not get a new code.");
      setCode(payload.code);
      setLeft(payload.resendsLeft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not get a new code.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 text-sm" data-testid="own-delivery-code">
      {code ? (
        <p>
          Delivery code: <span className="font-mono text-lg font-bold tracking-widest">{code}</span> — give it to the delivery
          person only when you receive your order. Your earlier code no longer works.
        </p>
      ) : (
        <p>Your delivery code was emailed to {state.maskedEmail}. Give it to the delivery person only when you receive your order.</p>
      )}
      {left > 0 ? (
        <div className="mt-1">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void newCode()}>
            {busy ? "Sending…" : code ? "Get another code" : "Get a new code"}
          </Button>
        </div>
      ) : null}
      {error ? <p className="mt-1 text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
