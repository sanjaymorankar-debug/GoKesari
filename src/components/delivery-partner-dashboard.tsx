"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Money } from "@/components/ui";

export interface ActiveDelivery {
  id: string;
  status: string;
  orderNumber: string;
  orderTotalPaise: number;
  shopName: string;
  shopAddress: string;
  customerAddress: string | null;
  distanceKm: string | null;
  /** The shop must give the rider a pickup code (Slice 4). */
  needsPickupCode: boolean;
  /** The customer must give the rider a delivery code. */
  needsDeliveryOtp: boolean;
  /** Set once the rider has left the shop for the customer. */
  outForDeliveryAt: Date | string | null;
  /** Landmark / customer's delivery instructions. */
  customerNotes: string | null;
  /** Society gate / parking notes, for society deliveries. */
  societyName: string | null;
  societyInstructions: string | null;
}

export interface EarningsSummary {
  todayPaise: number;
  totalPaise: number;
  deliveryCount: number;
}

export interface RiderRating {
  avgX100: number;
  count: number;
}

const STATUS_LABEL: Record<string, string> = {
  OFFERED: "New delivery offer — accept within 2 minutes",
  ACCEPTED: "Accepted — head to the shop and ask for the pickup code",
  PICKED_UP: "Picked up — deliver to the customer",
};

/** 4-digit code entry for pickup/delivery handover. */
function CodeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      className="w-40 rounded-lg border border-cream-200 px-3 py-2 text-sm tracking-widest"
      inputMode="numeric"
      maxLength={4}
      placeholder={label}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
    />
  );
}

/**
 * Online/offline toggle, active delivery actions, earnings summary
 * (delivery-system Part 58, Slice C). Location comes only from the
 * browser's native geolocation — never a Google Maps Platform call.
 */
export function DeliveryPartnerDashboard({
  isOnline: initialOnline,
  activeDelivery,
  earnings,
  rating,
}: {
  isOnline: boolean;
  activeDelivery: ActiveDelivery | null;
  earnings: EarningsSummary;
  /** The rider's own average (GS-060), shown only to them. */
  rating?: RiderRating;
}) {
  const router = useRouter();
  const [isOnline, setIsOnline] = useState(initialOnline);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [failReason, setFailReason] = useState("");
  const [showFail, setShowFail] = useState(false);

  async function toggleOnline() {
    setError(null);
    if (isOnline) {
      setBusy(true);
      const response = await fetch("/api/delivery-partner/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "offline" }),
      });
      setBusy(false);
      if (!response.ok) {
        setError("Could not go offline. Try again.");
        return;
      }
      setIsOnline(false);
      router.refresh();
      return;
    }

    if (!("geolocation" in navigator)) {
      setError("Your browser does not support location — cannot go online.");
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const response = await fetch("/api/delivery-partner/status", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "online",
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          }),
        });
        setBusy(false);
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          setError(payload?.error?.message ?? "Could not go online.");
          return;
        }
        setIsOnline(true);
        router.refresh();
      },
      () => {
        setBusy(false);
        setError("Location permission is required to go online.");
      },
    );
  }

  async function act(
    action: "accept" | "reject" | "pickup" | "start" | "deliver" | "fail",
    extra: Record<string, string> = {},
  ) {
    if (!activeDelivery) return;
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/delivery-orders/${activeDelivery.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    if (response.ok) {
      setCode("");
      setFailReason("");
      setShowFail(false);
    }
    setBusy(false);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? "Action failed.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <Card className="flex items-center justify-between p-5">
        <div>
          <p className="font-semibold text-ink-900">{isOnline ? "You're online" : "You're offline"}</p>
          <p className="text-sm text-ink-500">
            {isOnline ? "You may be offered nearby deliveries." : "Go online to start receiving deliveries."}
          </p>
        </div>
        <Button
          variant={isOnline ? "secondary" : "primary"}
          disabled={busy || (!!activeDelivery && isOnline)}
          onClick={toggleOnline}
        >
          {isOnline ? "Go offline" : "Go online"}
        </Button>
      </Card>

      <div className="grid grid-cols-3 gap-3">
        <Card className="p-4">
          <p className="text-xs text-ink-500">Today</p>
          <p className="mt-1 text-lg font-bold text-ink-900">
            <Money paise={earnings.todayPaise} />
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Total earned</p>
          <p className="mt-1 text-lg font-bold text-ink-900">
            <Money paise={earnings.totalPaise} />
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Deliveries</p>
          <p className="mt-1 text-lg font-bold text-ink-900">{earnings.deliveryCount}</p>
          {rating && rating.count > 0 ? (
            <p className="text-xs text-ink-500">
              {(rating.avgX100 / 100).toFixed(1)}★ from {rating.count}
            </p>
          ) : null}
        </Card>
      </div>

      {activeDelivery ? (
        <Card className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-kesari-600">
            {STATUS_LABEL[activeDelivery.status] ?? activeDelivery.status}
          </p>
          <p className="mt-2 font-semibold text-ink-900">{activeDelivery.orderNumber}</p>
          <div className="mt-3 space-y-2 text-sm">
            <div>
              <p className="font-medium text-ink-700">Pickup</p>
              <p className="text-ink-500">{activeDelivery.shopName} — {activeDelivery.shopAddress}</p>
            </div>
            <div>
              <p className="font-medium text-ink-700">Drop</p>
              <p className="text-ink-500">{activeDelivery.customerAddress ?? "Address on order details"}</p>
              {activeDelivery.customerNotes ? <p className="text-ink-500">Note: {activeDelivery.customerNotes}</p> : null}
            </div>
            {activeDelivery.societyName ? (
              <div className="rounded-lg bg-cream-100 p-2" data-testid="society-notes">
                <p className="font-medium text-ink-700">{activeDelivery.societyName}</p>
                {activeDelivery.societyInstructions ? (
                  <p className="text-ink-600">{activeDelivery.societyInstructions}</p>
                ) : null}
              </div>
            ) : null}
            {activeDelivery.distanceKm ? (
              <p className="text-ink-500">~{Number(activeDelivery.distanceKm).toFixed(1)} km delivery leg</p>
            ) : null}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {activeDelivery.status === "OFFERED" ? (
              <>
                <Button size="sm" disabled={busy} onClick={() => act("accept")}>
                  Accept
                </Button>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => act("reject")}>
                  Reject
                </Button>
              </>
            ) : null}
            {activeDelivery.status === "ACCEPTED" ? (
              <>
                {activeDelivery.needsPickupCode ? (
                  <CodeInput
                    label="Pickup code from the shop"
                    value={code}
                    onChange={setCode}
                  />
                ) : null}
                <Button
                  size="sm"
                  disabled={busy || (activeDelivery.needsPickupCode && code.length !== 4)}
                  onClick={() => act("pickup", { pickupCode: code })}
                >
                  Confirm pickup
                </Button>
              </>
            ) : null}
            {activeDelivery.status === "PICKED_UP" &&
            activeDelivery.needsPickupCode &&
            !activeDelivery.outForDeliveryAt ? (
              <Button size="sm" disabled={busy} onClick={() => act("start")}>
                Start delivery
              </Button>
            ) : null}
            {activeDelivery.status === "PICKED_UP" &&
            (activeDelivery.outForDeliveryAt || !activeDelivery.needsPickupCode) ? (
              <>
                {activeDelivery.needsDeliveryOtp ? (
                  <CodeInput
                    label="Delivery code from the customer"
                    value={code}
                    onChange={setCode}
                  />
                ) : null}
                <Button
                  size="sm"
                  disabled={busy || (activeDelivery.needsDeliveryOtp && code.length !== 4)}
                  onClick={() => act("deliver", { otp: code })}
                >
                  Mark delivered
                </Button>
              </>
            ) : null}
            {activeDelivery.status === "PICKED_UP" ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setShowFail((v) => !v)}>
                Could not deliver
              </Button>
            ) : null}
          </div>

          {showFail ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                className="min-w-0 flex-1 rounded-lg border border-cream-200 px-3 py-2 text-sm"
                placeholder="What happened? e.g. customer not reachable"
                value={failReason}
                onChange={(e) => setFailReason(e.target.value)}
                aria-label="Reason the delivery failed"
              />
              <Button
                size="sm"
                variant="danger"
                disabled={busy || failReason.trim().length < 3}
                onClick={() => act("fail", { reason: failReason })}
              >
                Report failed delivery
              </Button>
            </div>
          ) : null}
        </Card>
      ) : isOnline ? (
        <Card className="p-5 text-sm text-ink-500">Waiting for a delivery offer…</Card>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
