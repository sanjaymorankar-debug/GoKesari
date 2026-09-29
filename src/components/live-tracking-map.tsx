"use client";

import { useEffect, useState } from "react";

import { Alert, Card, StatusBadge } from "@/components/ui";
import type { OrderTracking } from "@/lib/tracking";

const POLL_INTERVAL_MS = 15_000;

export function LiveTrackingMap({ orderId }: { orderId: string }) {
  const [tracking, setTracking] = useState<OrderTracking | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      let keepPolling = true;
      try {
        const response = await fetch(`/api/tracking/${orderId}`, { cache: "no-store" });
        if (response.ok) {
          const data: OrderTracking = await response.json();
          if (cancelled) return;
          setTracking(data);
          setError(null);
          keepPolling = data.stage !== "ENDED";
        } else {
          const payload: { error?: { message?: string } } | null = await response.json().catch(() => null);
          if (cancelled) return;
          setError(payload?.error?.message ?? "Could not load delivery tracking.");
          keepPolling = response.status >= 500;
        }
      } catch {
        if (cancelled) return;
        setError("Could not load delivery tracking. Retrying.");
      }
      if (!cancelled && keepPolling) timer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [orderId]);

  if (!tracking) {
    return error ? (
      <Alert tone="danger">{error}</Alert>
    ) : (
      <Card className="p-5 text-sm text-ink-500">Loading delivery tracking…</Card>
    );
  }

  const { riderLocation, etaMinutes, distanceToDestinationKm } = tracking;

  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-ink-900">Delivery tracking</h3>
        <StatusBadge status={tracking.orderStatus} />
      </div>

      {tracking.stage === "ENDED" ? (
        <p className="text-sm text-ink-600">Tracking has ended for this order.</p>
      ) : tracking.stage === "AWAITING_PICKUP" ? (
        <p className="text-sm text-ink-600">The rider&apos;s location appears here once they pick up the order.</p>
      ) : tracking.stage === "NOT_TRACKED" ? (
        <p className="text-sm text-ink-600">Live rider tracking isn&apos;t available for this order.</p>
      ) : !riderLocation ? (
        <p className="text-sm text-ink-600">Waiting for the rider&apos;s location.</p>
      ) : (
        <div className="space-y-1">
          {etaMinutes !== null && distanceToDestinationKm !== null ? (
            <p className="text-sm text-ink-700">
              About <span className="font-semibold">{etaMinutes} min</span> away ·{" "}
              {distanceToDestinationKm} km in a straight line
            </p>
          ) : null}
          <p className="text-xs text-ink-500">
            Rider location updated at {new Date(riderLocation.recordedAt).toLocaleTimeString()}
          </p>
        </div>
      )}

      {error ? <Alert tone="warning">{error}</Alert> : null}
    </Card>
  );
}
