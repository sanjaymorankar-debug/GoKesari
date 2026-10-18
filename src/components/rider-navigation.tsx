"use client";

/**
 * F4.2.2 (batch-2026-10 WS-B): the rider's in-app navigation screen — the
 * route line on a map (Google Maps JS when a browser key is set, otherwise a
 * plain SVG drawing of the route, no extra library or tile server), the next
 * manoeuvre, remaining distance and time, voice prompts
 * (window.speechSynthesis, toggle), a fresh route when the rider strays more
 * than the rule's offRouteMeters from it, and "Open in Google Maps".
 *
 * It keeps feeding live tracking exactly like the dashboard: the same
 * location heartbeat, the same endpoints and cadence (rule tracking).
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  HEARTBEAT_IDLE_MS,
  HEARTBEAT_ON_DELIVERY_MS,
  RIDER_LOCATION_URL,
  useLocationHeartbeat,
} from "@/components/delivery-partner-dashboard";
import { Alert, Button, Card } from "@/components/ui";
import { isMapsAvailable, loadGoogleMaps } from "@/lib/geo/provider";
import {
  decodePolyline,
  formatDistance,
  metersToStep,
  nextStepIndex,
  routeProgress,
  type LatLng,
  type NavRoute,
} from "@/lib/navigation/geometry";

export interface NavigationView {
  deliveryOrderId: string;
  orderNumber: string;
  status: "ACCEPTED" | "PICKED_UP";
  leg: "TO_SHOP" | "TO_CUSTOMER";
  origin: LatLng;
  destination: LatLng & { label: string };
  route: NavRoute;
  googleMapsUrl: string;
  settings: { offRouteMeters: number; rerouteCooldownSeconds: number; voiceDefaultOn: boolean; trackingPingSeconds: number };
  dropStarted: boolean;
}

const ARROWS: Record<string, string> = {
  depart: "↑",
  arrive: "⚑",
  uturn: "↶",
  roundabout: "⟳",
  left: "←",
  "slight left": "↖",
  "sharp left": "↙",
  right: "→",
  "slight right": "↗",
  "sharp right": "↘",
  straight: "↑",
};
const arrowFor = (maneuver: string, modifier: string | null) =>
  ARROWS[maneuver === "turn" || maneuver === "fork" || maneuver === "merge" ? (modifier ?? "straight") : maneuver] ??
  ARROWS[modifier ?? ""] ??
  "↑";

/* ------------------------------------------------------------------- maps */

function GoogleRouteMap({ points, position, destination }: { points: LatLng[]; position: LatLng | null; destination: LatLng }) {
  const div = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const line = useRef<google.maps.Polyline | null>(null);
  const rider = useRef<google.maps.Marker | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const path = points.map((p) => ({ lat: p.latitude, lng: p.longitude }));
    loadGoogleMaps()
      .then(() => {
        if (cancelled || !div.current) return;
        if (!map.current) {
          map.current = new google.maps.Map(div.current, { disableDefaultUI: true, zoomControl: true });
          new google.maps.Marker({ position: { lat: destination.latitude, lng: destination.longitude }, map: map.current, title: "Destination" });
        }
        line.current?.setMap(null);
        line.current = new google.maps.Polyline({ path, map: map.current, strokeColor: "#ea580c", strokeWeight: 5 });
        const bounds = new google.maps.LatLngBounds();
        path.forEach((p) => bounds.extend(p));
        map.current.fitBounds(bounds, 32);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [points, destination]);

  useEffect(() => {
    if (!map.current || !position) return;
    const p = { lat: position.latitude, lng: position.longitude };
    if (!rider.current) {
      rider.current = new google.maps.Marker({
        position: p,
        map: map.current,
        title: "You",
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: "#2563eb", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 },
      });
    } else rider.current.setPosition(p);
  }, [position]);

  if (failed) return <SvgRouteMap points={points} position={position} destination={destination} />;
  return <div ref={div} className="h-72 w-full overflow-hidden rounded-lg bg-cream-100" data-testid="nav-map" />;
}

/** No map key: the route drawn to scale on a plain background. */
function SvgRouteMap({ points, position, destination }: { points: LatLng[]; position: LatLng | null; destination: LatLng }) {
  const all = [...points, destination, ...(position ? [position] : [])];
  const lat0 = all.reduce((s, p) => s + p.latitude, 0) / all.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = all.map((p) => p.longitude * k);
  const ys = all.map((p) => -p.latitude);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY, 1e-6);
  const SIZE = 300;
  const PAD = 20;
  const project = (p: LatLng) => ({
    x: PAD + ((p.longitude * k - minX) / span) * (SIZE - 2 * PAD),
    y: PAD + ((-p.latitude - minY) / span) * (SIZE - 2 * PAD),
  });
  const path = points
    .map(project)
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
  const d = project(destination);
  const r = position ? project(position) : null;
  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-72 w-full rounded-lg bg-cream-100" role="img" aria-label="Route map" data-testid="nav-map-svg">
      <path d={path} fill="none" stroke="#ea580c" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={d.x} cy={d.y} r={8} fill="#15803d" stroke="#fff" strokeWidth={2} />
      {r ? <circle cx={r.x} cy={r.y} r={7} fill="#2563eb" stroke="#fff" strokeWidth={2} /> : null}
    </svg>
  );
}

/* ------------------------------------------------------------------ screen */

const noSubscribe = () => () => {};

export function RiderNavigation({ initial }: { initial: NavigationView }) {
  const [nav, setNav] = useState(initial);
  const [position, setPosition] = useState<LatLng | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [voiceOn, setVoiceOn] = useState(initial.settings.voiceDefaultOn);
  const [rerouting, setRerouting] = useState(false);
  const [pingMs, setPingMs] = useState(initial.settings.trackingPingSeconds * 1000);
  const [notice, setNotice] = useState<string | null>(null);
  // Wall clock of the latest fix — the arrival time is worked out from it, not read during render.
  const [clock, setClock] = useState(() => Date.now());
  const geoSupported = useSyncExternalStore(noSubscribe, () => "geolocation" in navigator, () => true);
  const lastReroute = useRef(0);
  const spokenStep = useRef<string | null>(null);
  const voiceSupported = useSyncExternalStore(
    noSubscribe,
    () => "speechSynthesis" in window,
    () => false,
  );

  const points = useMemo(() => decodePolyline(nav.route.polyline), [nav.route.polyline]);
  const steps = nav.route.steps;

  // The rider's position, for progress and off-route checks (browser geolocation only).
  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    let id: number | null = null;
    try {
      id = navigator.geolocation.watchPosition(
        (p) => {
          setPosition({ latitude: p.coords.latitude, longitude: p.coords.longitude });
          setClock(Date.now());
          setGpsError(null);
        },
        (err) => setGpsError(err.code === err.PERMISSION_DENIED ? "Location permission is needed for navigation." : "Waiting for your location…"),
        { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
      );
    } catch {
      // Embedded WebView / Permissions-Policy: report it asynchronously, like a denied permission.
      queueMicrotask(() => setGpsError("Location is blocked here."));
    }
    return () => {
      if (id !== null) navigator.geolocation.clearWatch(id);
    };
  }, []);

  // Live tracking keeps flowing while navigating — same endpoint and cadence as the dashboard.
  const locationIssue = useLocationHeartbeat(
    true,
    nav.dropStarted ? pingMs : nav.status === "PICKED_UP" ? HEARTBEAT_ON_DELIVERY_MS : HEARTBEAT_IDLE_MS,
    () => setNotice("You are offline on the server — go online on your dashboard to keep sharing your location."),
    nav.dropStarted ? `/api/delivery-orders/${nav.deliveryOrderId}/location` : RIDER_LOCATION_URL,
    (reply) => {
      if (typeof reply.nextPingSeconds === "number") setPingMs(reply.nextPingSeconds * 1000);
      if (reply.sharing === false) setNotice("This delivery is over — head back to your dashboard.");
    },
  );

  const progress = position && points.length > 0 ? routeProgress(position, points) : null;
  const stepIndex = progress ? nextStepIndex(steps, progress.alongMeters) : Math.min(1, Math.max(0, steps.length - 1));
  const step = steps[stepIndex];
  const toStep = progress ? metersToStep(steps, stepIndex, progress.alongMeters) : (steps[0]?.distanceMeters ?? 0);
  const remaining = progress ? progress.remainingMeters : nav.route.distanceMeters;
  const speed = nav.route.durationSeconds > 0 ? nav.route.distanceMeters / nav.route.durationSeconds : 20 / 3.6;
  const etaSeconds = remaining / Math.max(speed, 1);
  const offRoute = progress != null && progress.offRouteMeters > nav.settings.offRouteMeters;

  const speak = useCallback(
    (text: string) => {
      if (!voiceOn || !voiceSupported) return;
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "en-IN";
        window.speechSynthesis.speak(u);
      } catch {
        // speech is best effort
      }
    },
    [voiceOn, voiceSupported],
  );

  // Voice: announce each new manoeuvre once.
  useEffect(() => {
    if (!step) return;
    const key = `${nav.route.polyline.length}:${stepIndex}`;
    if (spokenStep.current === key) return;
    spokenStep.current = key;
    speak(step.maneuver === "arrive" ? step.instruction : `In ${formatDistance(toStep)}, ${step.instruction}`);
    // toStep deliberately left out: speak when the step changes, not every metre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex, nav.route.polyline, speak]);

  // Re-route from where the rider is, at most once per cooldown.
  useEffect(() => {
    if (!offRoute || !position || rerouting) return;
    if (Date.now() - lastReroute.current < nav.settings.rerouteCooldownSeconds * 1000) return;
    lastReroute.current = Date.now();
    let cancelled = false;
    setRerouting(true);
    speak("Off route. Finding a new route.");
    fetch(`/api/delivery-orders/${nav.deliveryOrderId}/navigation?lat=${position.latitude}&lng=${position.longitude}`, {
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) return;
        const next: NavigationView = await res.json();
        if (!cancelled) setNav(next);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRerouting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [offRoute, position, rerouting, nav.deliveryOrderId, nav.settings.rerouteCooldownSeconds, speak]);

  const arrival = new Date(clock + etaSeconds * 1000).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

  return (
    <div className="space-y-4" data-testid="rider-navigation">
      <Card className="p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-kesari-600">
          {nav.leg === "TO_SHOP" ? "To the shop" : "To the customer"} · Order {nav.orderNumber}
        </p>
        <p className="mt-1 text-sm text-ink-600">{nav.destination.label}</p>
        {step ? (
          <div className="mt-3 flex items-center gap-3" data-testid="next-maneuver">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-kesari-100 text-2xl text-kesari-800" aria-hidden>
              {arrowFor(step.maneuver, step.modifier)}
            </span>
            <div>
              <p className="text-lg font-semibold text-ink-900">{step.instruction}</p>
              {step.maneuver !== "arrive" ? <p className="text-sm text-ink-600">in {formatDistance(toStep)}</p> : null}
            </div>
          </div>
        ) : null}
        <p className="mt-3 text-sm text-ink-700" data-testid="nav-eta" suppressHydrationWarning>
          {formatDistance(remaining)} to go · about {Math.max(1, Math.round(etaSeconds / 60))} min · arrive around {arrival}
        </p>
        {offRoute ? (
          <p className="mt-1 text-sm font-medium text-red-700">{rerouting ? "Off route — finding a new route…" : "Off route"}</p>
        ) : null}
        {nav.route.provider === "straight_line" || nav.route.provider === "mock" ? (
          <p className="mt-1 text-xs text-ink-500">Straight-line guide — follow the roads, or open Google Maps for turn-by-turn.</p>
        ) : null}
      </Card>

      {isMapsAvailable() ? (
        <GoogleRouteMap points={points} position={position} destination={nav.destination} />
      ) : (
        <SvgRouteMap points={points} position={position} destination={nav.destination} />
      )}

      <div className="flex flex-wrap gap-2">
        <a
          href={nav.googleMapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center rounded-lg border border-cream-200 bg-white px-3 py-2 text-sm font-medium text-ink-900"
          data-testid="open-google-maps"
        >
          Open in Google Maps
        </a>
        {voiceSupported ? (
          <Button size="sm" variant="secondary" onClick={() => setVoiceOn((v) => !v)} aria-pressed={voiceOn}>
            {voiceOn ? "Voice on" : "Voice off"}
          </Button>
        ) : null}
        <Link href="/delivery-partner" className="inline-flex items-center px-3 py-2 text-sm font-medium text-kesari-700 underline">
          Back to my delivery
        </Link>
      </div>

      {steps.length > 0 ? (
        <Card className="p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Route</p>
          <ol className="space-y-1 text-sm">
            {steps.map((s, i) => (
              <li key={i} className={i === stepIndex ? "font-semibold text-ink-900" : i < stepIndex ? "text-ink-400" : "text-ink-600"}>
                {arrowFor(s.maneuver, s.modifier)} {s.instruction}
                {s.distanceMeters > 0 ? <span className="text-xs text-ink-500"> · {formatDistance(s.distanceMeters)}</span> : null}
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      {!geoSupported ? <Alert tone="warning">Location is not available on this device.</Alert> : null}
      {gpsError ? <Alert tone="warning">{gpsError}</Alert> : null}
      {locationIssue === "blocked" ? <Alert tone="warning">Location is blocked — live tracking for the customer won&apos;t update.</Alert> : null}
      {notice ? <Alert tone="info">{notice}</Alert> : null}
    </div>
  );
}
