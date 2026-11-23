"use client";

import { useEffect, useRef, useState } from "react";

import { Alert, Button, Card, StatusBadge } from "@/components/ui";
import { isMapsAvailable, loadGoogleMaps } from "@/lib/geo/provider";
import type { OrderTracking } from "@/lib/tracking";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang } from "@/lib/board/i18n";

/** Wording (Module 6, docs/hindi-marathi-2026-11/). */
const T = {
  hide: L("Hide tracking", "ट्रैकिंग छिपाएँ", "ट्रॅकिंग लपवा"),
  track: L("Track delivery", "डिलीवरी ट्रैक करें", "डिलिव्हरी ट्रॅक करा"),
  yourRider: L("Your rider", "आपका राइडर", "तुमचा रायडर"),
  seeRider: L("See where your rider is", "देखें आपका राइडर कहाँ है", "तुमचा रायडर कुठे आहे ते पहा"),
  loadFailed: L("Could not load delivery tracking.", "डिलीवरी ट्रैकिंग लोड नहीं हो सकी।", "डिलिव्हरी ट्रॅकिंग लोड झाली नाही."),
  loadRetry: L("Could not load delivery tracking. Retrying.", "डिलीवरी ट्रैकिंग लोड नहीं हो सकी। फिर कोशिश कर रहे हैं।", "डिलिव्हरी ट्रॅकिंग लोड झाली नाही. पुन्हा प्रयत्न करत आहोत."),
  loading: L("Loading delivery tracking…", "डिलीवरी ट्रैकिंग लोड हो रही है…", "डिलिव्हरी ट्रॅकिंग लोड होत आहे…"),
  title: L("Delivery tracking", "डिलीवरी ट्रैकिंग", "डिलिव्हरी ट्रॅकिंग"),
  ended: L("Tracking has ended for this order.", "इस ऑर्डर की ट्रैकिंग खत्म हो गई है।", "या ऑर्डरचे ट्रॅकिंग संपले आहे."),
  estimated: L("Estimated arrival around", "लगभग पहुँचने का समय", "अंदाजे पोहोचण्याची वेळ"),
  appearsOnce: L(
    "The rider's location appears here once they set off to you.",
    "राइडर के आपकी ओर निकलते ही उसकी लोकेशन यहाँ दिखेगी।",
    "रायडर तुमच्याकडे निघाल्यावर त्याचे ठिकाण इथे दिसेल.",
  ),
  collected: L(
    "The rider has collected your order. You can follow them here as soon as they set off.",
    "राइडर ने आपका ऑर्डर ले लिया है। उसके निकलते ही आप उसे यहाँ देख सकेंगे।",
    "रायडरने तुमची ऑर्डर घेतली आहे. तो निघताच तुम्ही त्याला इथे पाहू शकाल.",
  ),
  notTracked: L(
    "Live rider tracking isn't available for this order.",
    "इस ऑर्डर के लिए लाइव राइडर ट्रैकिंग उपलब्ध नहीं है।",
    "या ऑर्डरसाठी थेट रायडर ट्रॅकिंग उपलब्ध नाही.",
  ),
  waiting: L("Waiting for the rider's location.", "राइडर की लोकेशन का इंतज़ार है।", "रायडरच्या ठिकाणाची वाट पाहत आहोत."),
  about: L("About", "लगभग", "सुमारे"),
  away: L("away ·", "दूर ·", "दूर ·"),
  byRoad: L("by road", "सड़क से", "रस्त्याने"),
  straight: L("in a straight line", "सीधी रेखा में", "सरळ रेषेत"),
  arriving: L("arriving around", "पहुँचने का समय लगभग", "पोहोचण्याची वेळ सुमारे"),
  updatedAt: L("Rider location updated at", "राइडर की लोकेशन अपडेट हुई:", "रायडरचे ठिकाण अपडेट झाले:"),
} as const;

/** Until the server says otherwise (rule tracking.buyerPollSeconds). */
const DEFAULT_POLL_MS = 5_000;

/**
 * Live tracking (event layer): a "Track delivery" button that opens the
 * tracking panel. The map — one Maps JS load — is only paid for when someone
 * actually opens it, and the 5-second poll only runs while it is open.
 */
export function TrackDeliveryButton({ orderId, lang = "en" }: { orderId: string; lang?: Lang }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <Button size="sm" variant="secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {tr(open ? T.hide : T.track, lang)}
      </Button>
      {open ? <LiveTrackingMap orderId={orderId} lang={lang} /> : null}
    </div>
  );
}

/**
 * The rider on a map, moved on every poll without reloading the map. Without
 * a Maps key it falls back to a plain link — never a paid call per update.
 */
function RiderMap({ latitude, longitude, lang = "en" }: { latitude: number; longitude: number; lang?: Lang }) {
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
        marker.current = new google.maps.Marker({ position, map: map.current, title: tr(T.yourRider, lang) });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [latitude, longitude, failed, lang]);

  if (failed) {
    return (
      <a
        className="text-sm font-medium text-ink-900 underline"
        href={`https://www.google.com/maps?q=${latitude},${longitude}`}
        target="_blank"
        rel="noreferrer"
      >
        {tr(T.seeRider, lang)}
      </a>
    );
  }
  return <div ref={mapDiv} className="h-64 w-full overflow-hidden rounded-lg bg-cream-100" data-testid="rider-map" />;
}

export function LiveTrackingMap({ orderId, lang = "en" }: { orderId: string; lang?: Lang }) {
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
          const payload: { error?: { message?: string; code?: string } } | null = await response.json().catch(() => null);
          if (cancelled) return;
          setError(payload?.error?.message ? errorText(payload.error.message, lang, payload.error.code) : tr(T.loadFailed, lang));
          keepPolling = response.status >= 500;
        }
      } catch {
        if (cancelled) return;
        setError(tr(T.loadRetry, lang));
      }
      if (!cancelled && keepPolling) timer = setTimeout(poll, pollMs);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [orderId, lang]);

  if (!tracking) {
    return error ? (
      <Alert tone="danger">{error}</Alert>
    ) : (
      <Card className="p-5 text-sm text-ink-500">{tr(T.loading, lang)}</Card>
    );
  }

  const { riderLocation, etaMinutes, distanceToDestinationKm, etaSource, estimatedArrivalAt } = tracking;
  const arrival = estimatedArrivalAt
    ? new Date(estimatedArrivalAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })
    : null;

  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-ink-900">{tr(T.title, lang)}</h3>
        <StatusBadge status={tracking.orderStatus} />
      </div>

      {tracking.stage === "ENDED" ? (
        <p className="text-sm text-ink-600">{tr(T.ended, lang)}</p>
      ) : tracking.stage === "AWAITING_PICKUP" ? (
        <div className="space-y-1">
          {arrival ? (
            <p className="text-sm text-ink-700" data-testid="estimated-arrival">
              {tr(T.estimated, lang)} <span className="font-semibold">{arrival}</span>
            </p>
          ) : null}
          <p className="text-sm text-ink-600">{tr(T.appearsOnce, lang)}</p>
        </div>
      ) : tracking.stage === "AWAITING_START" ? (
        <p className="text-sm text-ink-600">
          {tr(T.collected, lang)}
        </p>
      ) : tracking.stage === "NOT_TRACKED" ? (
        <p className="text-sm text-ink-600">{tr(T.notTracked, lang)}</p>
      ) : !riderLocation ? (
        <p className="text-sm text-ink-600">{tr(T.waiting, lang)}</p>
      ) : (
        <div className="space-y-1">
          {etaMinutes !== null && distanceToDestinationKm !== null ? (
            <p className="text-sm text-ink-700">
              {tr(T.about, lang)} <span className="font-semibold">{etaMinutes} min</span> {tr(T.away, lang)}{" "}
              {distanceToDestinationKm} km {tr(etaSource === "ROAD" ? T.byRoad : T.straight, lang)}
              {arrival ? <> · {tr(T.arriving, lang)} <span className="font-semibold">{arrival}</span></> : null}
            </p>
          ) : null}
          <RiderMap latitude={riderLocation.latitude} longitude={riderLocation.longitude} lang={lang} />
          <p className="text-xs text-ink-500">
            {tr(T.updatedAt, lang)} {new Date(riderLocation.recordedAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}
          </p>
        </div>
      )}

      {error ? <Alert tone="warning">{error}</Alert> : null}
    </Card>
  );
}
