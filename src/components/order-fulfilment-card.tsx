"use client";

import { useState } from "react";

import { Button } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { tr, type Lang } from "@/lib/board/i18n";
import { FULFILMENT_OPTION_TEXT, localizeSlotText, ORDER_CARD as C } from "@/lib/order-status-i18n";

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
  /** Pickup: the delivery fee given back (paise). */
  deliveryFeeRefundedPaise?: number | null;
}

/**
 * Fulfilment options (docs/four-features-2026-10) on the customer's order:
 * how and when the order arrives, the pickup code to show at the shop, and
 * the delivery code for the shop's own delivery person.
 */
export function OrderFulfilmentCard({ orderId, info, lang = "en" }: { orderId: string; info: OrderFulfilmentInfo; lang?: Lang }) {
  return (
    <div className="mt-3 rounded-lg border border-kesari-100 bg-kesari-50 px-3 py-2 text-sm text-ink-800" data-testid="order-fulfilment">
      <p>
        <span className="font-medium">{lang === "en" ? info.optionLabel : tr(FULFILMENT_OPTION_TEXT[info.option], lang)}</span>
        {info.staffName ? ` · ${info.staffName}` : ""} · {localizeSlotText(info.whenLabel, lang)}
        {info.updated && !info.completed ? <span className="ml-1 text-xs text-kesari-700">{tr(C.updated, lang)}</span> : null}
      </p>
      {info.option === "PICKUP" && info.shopAddress && !info.completed ? (
        <p className="mt-0.5 text-xs text-ink-600">{tr(C.collectFrom, lang)} {info.shopAddress}</p>
      ) : null}
      {info.deliveryFeeRefundedPaise ? (
        <p className="mt-0.5 text-xs text-ink-600" data-testid="pickup-fee-refunded-customer">
          {tr(C.feeBackA, lang)} {formatPaise(info.deliveryFeeRefundedPaise)} {tr(C.feeBackB, lang)}
        </p>
      ) : null}
      {info.pickupCode ? (
        <p className="mt-2" data-testid="pickup-code-customer">
          {tr(C.pickupCode, lang)} <span className="font-mono text-lg font-bold tracking-widest">{info.pickupCode}</span>
          <span className="block text-xs text-ink-600">{tr(C.pickupHint, lang)}</span>
        </p>
      ) : null}
      {info.deliveryCode ? <OwnDeliveryCode orderId={orderId} state={info.deliveryCode} lang={lang} /> : null}
    </div>
  );
}

function OwnDeliveryCode({ orderId, state, lang }: { orderId: string; state: NonNullable<OrderFulfilmentInfo["deliveryCode"]>; lang: Lang }) {
  const [code, setCode] = useState<string | null>(null);
  const [left, setLeft] = useState(state.resendsLeft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.locked) {
    return (
      <p className="mt-2 text-sm text-amber-900" data-testid="own-delivery-code-locked">
        {tr(C.locked, lang)}
      </p>
    );
  }

  async function newCode() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/orders/${orderId}/fulfilment-plan/code`, { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? tr(C.codeFailed, lang));
      setCode(payload.code);
      setLeft(payload.resendsLeft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : tr(C.codeFailed, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 text-sm" data-testid="own-delivery-code">
      {code ? (
        <p>
          {tr(C.newCodeA, lang)} <span className="font-mono text-lg font-bold tracking-widest">{code}</span> {tr(C.newCodeB, lang)}
        </p>
      ) : (
        <p>
          {tr(C.emailedA, lang)} {state.maskedEmail}. {tr(C.emailedB, lang)}
        </p>
      )}
      {left > 0 ? (
        <div className="mt-1">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void newCode()}>
            {tr(busy ? C.sending : code ? C.another : C.newCode, lang)}
          </Button>
        </div>
      ) : null}
      {error ? <p className="mt-1 text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
