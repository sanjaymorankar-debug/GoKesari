"use client";

import { useEffect, useRef, useState } from "react";

import { Alert, Button, Card, StatusBadge } from "@/components/ui";
import { isMapsAvailable, loadGoogleMaps } from "@/lib/geo/provider";
import type { OrderTracking } from "@/lib/tracking";

/** Until the server says otherwise (rule tracking.buyerPollSeconds). */
const DEFAULT_POLL_MS = 5_000;

/**
 * Live tracking (event layer): a "Track delivery" button that opens the
 * tracking panel. The map — one Maps JS load — is only paid for when someone
 * actually opens it, and the 5-second poll only runs while it is open.
 */
export function TrackDeliveryButton({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <Button size="sm" variant="secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "Hide tracking" : "Track delivery"}
      </Button>
      {open ? <LiveTrackingMap orderId={orderId} /> : null}
    </div>
  );
}

/**
 * The rider on a map, moved on every poll without reloading the map. Without
 * a Maps key it falls back to a plain link — never a paid call per update.
 */
function RiderMap({ latitude, longitude }: { latitude: number; longitude: number }) {
  const mapDiv = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const marker = useRef<google.maps.Marker | null>(null);
  const [failed, setFailed] = useState(!isMapsAvailable());

  useEffect(() => {
    if (failed) return;
    const position = { lat: latitude, lng: longitude };
    if (map.current && marker.current) {
      marker.current.setPosition(position);
      map.current.panTo(position);
      return;
    }
    let cancelled = false;
    loadGoogleMaps()
      .then(() => {
        if (cancelled || !mapDiv.current || map.current) return;
        map.current = new google.maps.Map(mapDiv.current, {
          center: position,
          zoom: 15,
          disableDefaultUI: true,
          zoomControl: true,
        });
        marker.current = new google.maps.Marker({ position, map: map.current, title: "Your rider" });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [latitude, longitude, failed]);

  if (failed) {
    return (
      <a
        className="text-sm font-medium text-ink-900 underline"
        href={`https://www.google.com/maps?q=${latitude},${longitude}`}
        target="_blank"
        rel="noreferrer"
      >
        See where your rider is
      </a>
    );
  }
  return <div ref={mapDiv} className="h-64 w-full overflow-hidden rounded-lg bg-cream-100" data-testid="rider-map" />;
}

export function LiveTrackingMap({ orderId }: { orderId: string }) {
  const [tracking, setTracking] = useState<OrderTracking | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pollMs = DEFAULT_POLL_MS;

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
          if (data.pollSeconds) pollMs = data.pollSeconds * 1000;
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
      if (!cancelled && keepPolling) timer = setTimeout(poll, pollMs);
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

  const { riderLocation, etaMinutes, distanceToDestinationKm, etaSource, estimatedArrivalAt } = tracking;
  const arrival = estimatedArrivalAt
    ? new Date(estimatedArrivalAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-ink-900">Delivery tracking</h3>
        <StatusBadge status={tracking.orderStatus} />
      </div>

      {tracking.stage === "ENDED" ? (
        <p className="text-sm text-ink-600">Tracking has ended for this order.</p>
      ) : tracking.stage === "AWAITING_PICKUP" ? (
        <div className="space-y-1">
          {arrival ? (
            <p className="text-sm text-ink-700" data-testid="estimated-arrival">
              Estimated arrival around <span className="font-semibold">{arrival}</span>
            </p>
          ) : null}
          <p className="text-sm text-ink-600">The rider&apos;s location appears here once they set off to you.</p>
        </div>
      ) : tracking.stage === "AWAITING_START" ? (
        <p className="text-sm text-ink-600">
          The rider has collected your order. You can follow them here as soon as they set off.
        </p>
      ) : tracking.stage === "NOT_TRACKED" ? (
        <p className="text-sm text-ink-600">Live rider tracking isn&apos;t available for this order.</p>
      ) : !riderLocation ? (
        <p className="text-sm text-ink-600">Waiting for the rider&apos;s location.</p>
      ) : (
        <div className="space-y-1">
          {etaMinutes !== null && distanceToDestinationKm !== null ? (
            <p className="text-sm text-ink-700">
              About <span className="font-semibold">{etaMinutes} min</span> away ·{" "}
              {distanceToDestinationKm} km {etaSource === "ROAD" ? "by road" : "in a straight line"}
              {arrival ? <> · arriving around <span className="font-semibold">{arrival}</span></> : null}
            </p>
          ) : null}
          <RiderMap latitude={riderLocation.latitude} longitude={riderLocation.longitude} />
          <p className="text-xs text-ink-500">
            Rider location updated at {new Date(riderLocation.recordedAt).toLocaleTimeString()}
          </p>
        </div>
      )}

      {error ? <Alert tone="warning">{error}</Alert> : null}
    </Card>
  );
}
