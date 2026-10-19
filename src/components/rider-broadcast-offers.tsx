"use client";

/**
 * F3.3.2 (batch-2026-10 WS-B): broadcast offers on the rider's dashboard —
 * orders sent to every rider nearby, first to accept gets it. Polls
 * /api/delivery-partner/broadcast-offers every dispatchBroadcast.riderPollSeconds
 * (the same fetch-and-reschedule loop as the live tracking map) and counts
 * down each offer locally. An offer another rider took shows "Offer taken"
 * instead of the Accept button.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Alert, Badge, Button, Card, Money } from "@/components/ui";

export interface BroadcastOfferView {
  broadcastId: string;
  state: "OPEN" | "TAKEN" | "EXPIRED";
  orderNumber: string;
  shopName: string;
  shopArea: string;
  distanceToShopKm: number | null;
  deliveryLegKm: number | null;
  earningsPaise: number | null;
  expiresAt: string | null;
  secondsLeft: number | null;
}

const DEFAULT_POLL_MS = 10_000;

function countdown(expiresAt: string | null, now: number): string | null {
  if (!expiresAt) return null;
  const left = Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

export function RiderBroadcastOffers({ initialPollSeconds }: { initialPollSeconds: number }) {
  const router = useRouter();
  const [offers, setOffers] = useState<BroadcastOfferView[]>([]);
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pollMs = initialPollSeconds * 1000 || DEFAULT_POLL_MS;
    async function poll() {
      try {
        const res = await fetch("/api/delivery-partner/broadcast-offers", { cache: "no-store" });
        if (res.ok) {
          const body: { enabled: boolean; pollSeconds: number | null; offers: BroadcastOfferView[] } = await res.json();
          if (cancelled) return;
          setOffers(body.offers);
          if (body.pollSeconds) pollMs = body.pollSeconds * 1000;
          if (!body.enabled) return; // switched off: stop polling
        }
      } catch {
        // offline for a moment: try again on the next tick
      }
      if (!cancelled) timer = setTimeout(poll, pollMs);
    }
    void poll();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(tick);
    };
  }, [initialPollSeconds]);

  async function act(broadcastId: string, action: "accept" | "decline") {
    setBusy(broadcastId);
    setError(null);
    try {
      const res = await fetch(`/api/delivery-partner/broadcast-offers/${broadcastId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        setOffers((list) => list.filter((o) => o.broadcastId !== broadcastId));
        if (action === "accept") router.refresh();
        return;
      }
      const body = await res.json().catch(() => null);
      if (body?.error?.details?.reason === "OFFER_TAKEN") {
        setTaken((s) => new Set(s).add(broadcastId));
      } else {
        setError(body?.error?.message ?? "Could not update the offer.");
      }
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  if (offers.length === 0 && !error) return null;

  return (
    <div className="space-y-3" data-testid="broadcast-offers">
      {offers.map((offer) => {
        const isTaken = offer.state === "TAKEN" || taken.has(offer.broadcastId);
        const left = countdown(offer.expiresAt, now);
        const expired = offer.state === "EXPIRED" || (offer.state === "OPEN" && left === "0s");
        return (
          <Card key={offer.broadcastId} className="p-4" data-testid="broadcast-offer">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-kesari-600">
                {isTaken ? "Offer taken" : expired ? "Offer expired" : "Open delivery — first to accept gets it"}
              </p>
              {!isTaken && !expired && left ? <Badge tone="warning">{left} left</Badge> : null}
            </div>
            <p className="mt-1 font-semibold text-ink-900">
              {offer.shopName} <span className="text-sm font-normal text-ink-500">· {offer.shopArea}</span>
            </p>
            <p className="text-sm text-ink-600">
              Order {offer.orderNumber}
              {offer.distanceToShopKm != null ? ` · ${offer.distanceToShopKm.toFixed(1)} km to the shop` : ""}
              {offer.deliveryLegKm != null ? ` · ${offer.deliveryLegKm.toFixed(1)} km delivery` : ""}
            </p>
            {offer.earningsPaise != null && !isTaken ? (
              <p className="text-sm text-ink-700">
                Earn about <Money paise={offer.earningsPaise} />
              </p>
            ) : null}
            {isTaken ? (
              <p className="mt-2 text-sm text-ink-500" data-testid="offer-taken">
                Another rider accepted this order first.
              </p>
            ) : expired ? null : (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" disabled={busy !== null} onClick={() => act(offer.broadcastId, "accept")}>
                  Accept
                </Button>
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => act(offer.broadcastId, "decline")}>
                  Not this one
                </Button>
              </div>
            )}
          </Card>
        );
      })}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
