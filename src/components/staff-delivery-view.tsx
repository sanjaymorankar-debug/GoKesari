"use client";

import { useState } from "react";

import { Alert, Button, Card, Money } from "@/components/ui";

export interface StaffDeliveryData {
  orderNumber: string;
  status: string;
  shopName: string;
  shopPhone: string | null;
  staffName: string;
  whenLabel: string;
  customer: {
    name: string;
    phone: string | null;
    address: string;
    landmark: string | null;
    instructions: string | null;
    mapsUrl: string | null;
  } | null;
  items: { name: string; quantity: string }[];
  cashToCollectPaise: number | null;
  locked: boolean;
  canStart: boolean;
  canComplete: boolean;
}

/**
 * What the shop's own delivery person sees on their delivery link
 * (docs/four-features-2026-10): where to go, whom to call, what to collect,
 * and the box for the customer's delivery code. Built for a phone.
 */
export function StaffDeliveryView({ token, initial }: { token: string; initial: StaffDeliveryData }) {
  const [data, setData] = useState(initial);
  const [code, setCode] = useState("");
  const [cash, setCash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/delivery-link/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "Something went wrong.");
      setData(payload);
      setCode("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const delivered = data.status === "DELIVERED";

  return (
    <div className="mx-auto max-w-md space-y-4" data-testid="staff-delivery">
      <div>
        <p className="text-xs uppercase tracking-wide text-ink-500">{data.shopName} · delivery for {data.staffName}</p>
        <h1 className="text-2xl font-semibold text-ink-900">Order {data.orderNumber}</h1>
        <p className="text-sm text-ink-600">{data.whenLabel}</p>
      </div>

      {delivered ? (
        <Alert tone="success" title="Delivered">Thank you — this delivery is complete.</Alert>
      ) : !data.customer ? (
        <Alert tone="info">This delivery is no longer open. Ask the shop if you need anything.</Alert>
      ) : (
        <>
          <Card className="space-y-2 p-4 text-sm">
            <p className="font-medium text-ink-900">{data.customer.name}</p>
            <p className="text-ink-700">{data.customer.address}</p>
            {data.customer.landmark ? <p className="text-ink-600">Landmark: {data.customer.landmark}</p> : null}
            {data.customer.instructions ? <p className="text-ink-600">Note: {data.customer.instructions}</p> : null}
            <div className="flex flex-wrap gap-2 pt-1">
              {data.customer.phone ? (
                <a href={`tel:${data.customer.phone}`} className="rounded-lg border border-cream-200 px-3 py-2 font-medium text-ink-800">
                  Call customer
                </a>
              ) : null}
              {data.customer.mapsUrl ? (
                <a href={data.customer.mapsUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-cream-200 px-3 py-2 font-medium text-kesari-700">
                  Directions
                </a>
              ) : null}
              {data.shopPhone ? (
                <a href={`tel:${data.shopPhone}`} className="rounded-lg border border-cream-200 px-3 py-2 font-medium text-ink-700">
                  Call shop
                </a>
              ) : null}
            </div>
          </Card>

          {data.items.length > 0 ? (
            <Card className="p-4 text-sm">
              <p className="mb-1 font-medium text-ink-900">Items</p>
              <ul className="space-y-0.5 text-ink-700">
                {data.items.map((item, index) => (
                  <li key={index}>
                    {item.name} · {item.quantity}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {data.cashToCollectPaise != null ? (
            <Alert tone="warning" title="Cash on delivery">
              Collect <Money paise={data.cashToCollectPaise} /> from the customer.
            </Alert>
          ) : null}

          {data.locked ? (
            <Alert tone="danger" title="On hold">Too many wrong codes. Support will confirm this delivery with the customer.</Alert>
          ) : null}

          {data.canStart ? (
            <Button size="lg" className="w-full" disabled={busy} onClick={() => void act({ action: "start" })}>
              {busy ? "Starting…" : "I have the order — start delivery"}
            </Button>
          ) : null}

          {data.canComplete ? (
            <Card className="p-4">
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act({ action: "complete", code, cashCollected: cash });
                }}
              >
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-ink-700">Customer&apos;s delivery code</span>
                  <input
                    className="w-full rounded-lg border border-cream-200 px-3 py-3 text-center font-mono text-2xl tracking-[0.5em]"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={4}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    aria-label="Customer's delivery code"
                  />
                  <span className="mt-1 block text-xs text-ink-500">Ask the customer for the 4-digit code in their order or email.</span>
                </label>
                {data.cashToCollectPaise != null ? (
                  <label className="flex items-center gap-2 text-sm text-ink-700">
                    <input type="checkbox" checked={cash} onChange={(e) => setCash(e.target.checked)} className="h-5 w-5 accent-kesari-600" />
                    I collected the cash
                  </label>
                ) : null}
                <Button type="submit" size="lg" className="w-full" disabled={busy || code.length !== 4 || (data.cashToCollectPaise != null && !cash)}>
                  {busy ? "Checking…" : "Confirm delivery"}
                </Button>
              </form>
            </Card>
          ) : null}
        </>
      )}

      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
