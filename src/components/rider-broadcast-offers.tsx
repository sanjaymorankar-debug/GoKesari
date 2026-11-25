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
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Module 6 (docs/hindi-marathi-2026-11/). */
const T = {
  errUpdate: L("Could not update the offer.", "ऑफ़र अपडेट नहीं हो सका।", "ऑफर अपडेट करता आली नाही."),
  errNoServer: L(
    "Could not reach the server. Check your connection and try again.",
    "सर्वर से संपर्क नहीं हो सका। इंटरनेट देखें और फिर कोशिश करें।",
    "सर्व्हरशी संपर्क झाला नाही. इंटरनेट तपासा आणि पुन्हा प्रयत्न करा.",
  ),
  taken: L("Offer taken", "ऑफ़र ले लिया गया", "ऑफर घेतली गेली"),
  expired: L("Offer expired", "ऑफ़र खत्म हो गया", "ऑफरची मुदत संपली"),
  open: L(
    "Open delivery — first to accept gets it",
    "खुली डिलीवरी — जो पहले स्वीकारे, उसे मिलेगी",
    "खुली डिलिव्हरी — जो आधी स्वीकारेल त्याला मिळेल",
  ),
  left: L("{t} left", "{t} बाकी", "{t} बाकी"),
  order: L("Order {n}", "ऑर्डर {n}", "ऑर्डर {n}"),
  toShop: L(" · {km} km to the shop", " · दुकान तक {km} km", " · दुकानापर्यंत {km} km"),
  delivery: L(" · {km} km delivery", " · {km} km डिलीवरी", " · {km} km डिलिव्हरी"),
  earn: L("Earn about", "लगभग कमाई", "सुमारे कमाई"),
  otherRider: L("Another rider accepted this order first.", "दूसरे राइडर ने यह ऑर्डर पहले स्वीकार कर लिया।", "दुसऱ्या रायडरने ही ऑर्डर आधी स्वीकारली."),
  accept: L("Accept", "स्वीकारें", "स्वीकारा"),
  notThis: L("Not this one", "यह नहीं", "ही नको"),
} as const;

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

export function RiderBroadcastOffers({ initialPollSeconds, lang = "en" }: { initialPollSeconds: number; lang?: Lang }) {
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
        setError(errorText(body?.error?.message ?? tr(T.errUpdate, lang), lang, body?.error?.code));
      }
    } catch {
      setError(tr(T.errNoServer, lang));
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
                {tr(isTaken ? T.taken : expired ? T.expired : T.open, lang)}
              </p>
              {!isTaken && !expired && left ? <Badge tone="warning">{tr(T.left, lang).replace("{t}", left)}</Badge> : null}
            </div>
            <p className="mt-1 font-semibold text-ink-900">
              {offer.shopName} <span className="text-sm font-normal text-ink-500">· {offer.shopArea}</span>
            </p>
            <p className="text-sm text-ink-600">
              {tr(T.order, lang).replace("{n}", offer.orderNumber)}
              {offer.distanceToShopKm != null ? tr(T.toShop, lang).replace("{km}", offer.distanceToShopKm.toFixed(1)) : ""}
              {offer.deliveryLegKm != null ? tr(T.delivery, lang).replace("{km}", offer.deliveryLegKm.toFixed(1)) : ""}
            </p>
            {offer.earningsPaise != null && !isTaken ? (
              <p className="text-sm text-ink-700">
                {tr(T.earn, lang)} <Money paise={offer.earningsPaise} />
              </p>
            ) : null}
            {isTaken ? (
              <p className="mt-2 text-sm text-ink-500" data-testid="offer-taken">
                {tr(T.otherRider, lang)}
              </p>
            ) : expired ? null : (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" disabled={busy !== null} onClick={() => act(offer.broadcastId, "accept")}>
                  {tr(T.accept, lang)}
                </Button>
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => act(offer.broadcastId, "decline")}>
                  {tr(T.notThis, lang)}
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
