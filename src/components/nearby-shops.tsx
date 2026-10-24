"use client";

/**
 * Nearby shops from the user's real position (docs/nearby-referral-2026-10,
 * feature 1), in the Tile Board look.
 *
 *  1. Asks the browser (or the app, whose bridge answers the same API) for
 *     the position — high accuracy — and shows the area / city / PIN found
 *     for it, with "Refresh location".
 *  2. The server lists approved live shops within the radius, nearest first,
 *     with the Haversine distance (/api/shops/nearby).
 *  3. Cards: name, type, open / closed, distance, Directions (Google Maps
 *     from here to the shop) — or the same on a map ("Map view").
 *  4. Location refused, unavailable or not over HTTPS: a clear message and a
 *     PIN code / area box to search from instead. No shop in range: "No shops
 *     found within X km" with a button to widen the radius.
 *  5. The position found also becomes the delivery location (POST
 *     /api/location, a cookie on this device) when none is chosen yet, so
 *     "Deliver to" and the rest of the site follow — a location already
 *     chosen is kept (24 Oct 2026).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";

import { Icon } from "@/components/board/icons";
import { NearbyMap } from "@/components/nearby-map";
import { saveDevicePosition } from "@/lib/device-location";
import { NEARBY_RADII_KM, DEFAULT_NEARBY_RADIUS_KM, placeLine, widerRadius, type NearbyRadiusKm } from "@/lib/geo/nearby";

export interface NearbyShop {
  id: string;
  slug: string;
  name: string;
  shopType: string;
  shopTypeLabel: string;
  area: string | null;
  city: string;
  pincode: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
  distanceText: string;
  open: boolean;
  takingOrders: boolean;
  deliveryAvailable: boolean;
  directionsUrl: string;
}

interface NearbyAnswer {
  origin: {
    latitude: number;
    longitude: number;
    source: "DEVICE" | "PLACE";
    place: { area: string | null; city: string | null; pincode: string | null } | null;
    /** The street address of a device position, when Google knows it. */
    address?: string | null;
  };
  radiusKm: NearbyRadiusKm;
  countsByRadius: Record<string, number>;
  shops: NearbyShop[];
}

type Search = { kind: "position"; latitude: number; longitude: number; accuracyM: number | null } | { kind: "place"; query: string };

type LocationProblem = "DENIED" | "UNAVAILABLE" | "TIMEOUT" | "INSECURE" | "UNSUPPORTED" | "WAITING";

const PROBLEM_TEXT: Record<LocationProblem, { title: string; detail: string }> = {
  DENIED: {
    title: "Location permission is off",
    detail:
      "Allow location for this site (the lock or ⓘ icon next to the address, or your phone's app settings) and tap Refresh location — or enter a PIN code or area below.",
  },
  UNAVAILABLE: {
    title: "We couldn't find your location",
    detail: "Turn on your phone's location (GPS) and tap Refresh location — or enter a PIN code or area below.",
  },
  TIMEOUT: {
    title: "Finding your location took too long",
    detail: "Move to an open spot or turn on GPS and tap Refresh location — or enter a PIN code or area below.",
  },
  INSECURE: {
    title: "Location needs a secure connection",
    detail: "Open this page at https://gokesari.com to use your location — or enter a PIN code or area below.",
  },
  // The permission prompt has not been answered (a browser's timeout only starts once it is).
  WAITING: {
    title: "Waiting for your location",
    detail: "Allow location when your browser or phone asks — or enter a PIN code or area below.",
  },
  UNSUPPORTED: {
    title: "This browser can't share its location",
    detail: "Enter a PIN code or area below to see shops near it.",
  },
};

function problemFromError(error: GeolocationPositionError | { code?: number }): LocationProblem {
  if (error.code === 1) return "DENIED";
  if (error.code === 3) return "TIMEOUT";
  return "UNAVAILABLE";
}

export function NearbyShops() {
  const router = useRouter();
  const [phase, setPhase] = useState<"locating" | "loading" | "ready" | "problem">("locating");
  const [problem, setProblem] = useState<LocationProblem | null>(null);
  const [search, setSearch] = useState<Search | null>(null);
  const [radius, setRadius] = useState<NearbyRadiusKm>(DEFAULT_NEARBY_RADIUS_KM);
  const [answer, setAnswer] = useState<NearbyAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "map">("list");
  const [manual, setManual] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const requestId = useRef(0);
  const locateId = useRef(0);

  const load = useCallback(async (next: Search, km: NearbyRadiusKm) => {
    const id = ++requestId.current;
    setPhase("loading");
    setError(null);
    const params = new URLSearchParams({ radiusKm: String(km) });
    if (next.kind === "position") {
      params.set("lat", next.latitude.toFixed(6));
      params.set("lng", next.longitude.toFixed(6));
    } else {
      params.set("q", next.query);
    }
    try {
      const res = await fetch(`/api/shops/nearby?${params.toString()}`, { cache: "no-store" });
      const payload = await res.json().catch(() => null);
      if (id !== requestId.current) return;
      if (!res.ok) throw new Error(payload?.error?.message ?? "Could not load nearby shops. Please try again.");
      setAnswer(payload as NearbyAnswer);
      if (next.kind === "place") setProblem(null);
      setPhase("ready");
    } catch (caught) {
      if (id !== requestId.current) return;
      setError(caught instanceof Error ? caught.message : "Could not load nearby shops. Please try again.");
      setPhase(next.kind === "place" ? "problem" : "ready");
    }
  }, []);

  const locate = useCallback(
    (km: NearbyRadiusKm) => {
      setProblem(null);
      setError(null);
      if (typeof window !== "undefined" && !window.isSecureContext) {
        setProblem("INSECURE");
        setPhase("problem");
        return;
      }
      if (!("geolocation" in navigator) || !navigator.geolocation) {
        setProblem("UNSUPPORTED");
        setPhase("problem");
        return;
      }
      setPhase("locating");
      const attempt = ++locateId.current;
      let answered = false;
      // No answer at all (prompt ignored or dismissed): offer the PIN code box rather than wait forever.
      window.setTimeout(() => {
        if (!answered && attempt === locateId.current) setProblem("WAITING");
      }, 12_000);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          answered = true;
          if (attempt !== locateId.current) return;
          setProblem(null);
          const next: Search = {
            kind: "position",
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracyM: Number.isFinite(pos.coords.accuracy) && pos.coords.accuracy > 0 ? Math.round(pos.coords.accuracy) : null,
          };
          setSearch(next);
          setManualOpen(false);
          void load(next, km);
          saveDevicePosition(next, { ifUnset: true })
            .then((saved) => saved.saved && router.refresh())
            .catch(() => {});
        },
        (err) => {
          answered = true;
          if (attempt !== locateId.current) return;
          setProblem(problemFromError(err));
          setPhase("problem");
        },
        { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
      );
    },
    [load, router],
  );

  // Ask for the position as soon as the screen opens (the radius starts at 5 km).
  useEffect(() => {
    queueMicrotask(() => locate(DEFAULT_NEARBY_RADIUS_KM));
  }, [locate]);

  function chooseRadius(km: NearbyRadiusKm) {
    setRadius(km);
    if (search) void load(search, km);
  }

  function searchPlace(event: React.FormEvent) {
    event.preventDefault();
    const query = manual.trim();
    if (query.length < 2) {
      setError("Enter a PIN code (6 digits) or an area name.");
      return;
    }
    const next: Search = { kind: "place", query };
    setSearch(next);
    setManualOpen(true);
    void load(next, radius);
  }

  const origin = answer?.origin ?? null;
  const fromPlace = search?.kind === "place";
  const placeText = origin?.address ?? placeLine(origin?.place ?? null);
  const counts = answer?.countsByRadius ?? {};
  const shops = answer?.shops ?? [];
  const wider = widerRadius(radius);
  const nextWithShops = NEARBY_RADII_KM.find((km) => km > radius && (counts[String(km)] ?? 0) > 0) ?? null;

  return (
    <div className="flex flex-col gap-3" data-testid="nearby-shops">
      {/* Where we are searching from */}
      <section className="rounded-2xl border-2 border-[var(--gk-line)] border-l-4 border-l-kesari-600 bg-white p-3 sm:p-4" aria-live="polite">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-kesari-100 text-kesari-700">
            <Icon name={fromPlace ? "map-pin" : "navigation"} size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-600">
              {fromPlace ? "Searching near" : "Your location"}
            </p>
            {phase === "locating" ? (
              <p className="text-base font-bold text-ink-900" data-testid="nearby-location">Finding your location…</p>
            ) : origin ? (
              <>
                {/* Two lines: a street address is longer than an area name. */}
                <p className="line-clamp-2 break-words text-base font-bold text-ink-900" data-testid="nearby-location">
                  {placeText ?? (fromPlace ? search.query : `${origin.latitude.toFixed(5)}, ${origin.longitude.toFixed(5)}`)}
                </p>
                <p className="text-xs text-ink-600">
                  {fromPlace
                    ? "From the PIN code / area you entered"
                    : `Detected by your device${search?.kind === "position" && search.accuracyM ? ` · accurate to about ${search.accuracyM} m` : ""}${placeText ? "" : " · area not known yet"}`}
                </p>
              </>
            ) : phase === "loading" ? (
              <p className="text-base font-bold text-ink-900" data-testid="nearby-location">Looking up shops…</p>
            ) : (
              <p className="text-base font-bold text-ink-900" data-testid="nearby-location">Location not shared</p>
            )}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => locate(radius)}
            disabled={phase === "locating"}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white hover:bg-kesari-800 disabled:opacity-60"
            data-testid="nearby-refresh"
          >
            <Icon name="refresh-cw" size={16} className={phase === "locating" ? "animate-spin" : undefined} />
            {phase === "locating" ? "Locating…" : "Refresh location"}
          </button>
          {!manualOpen && phase !== "problem" ? (
            <button
              type="button"
              onClick={() => setManualOpen(true)}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border-2 border-[var(--gk-line)] bg-[var(--gk-chip)] px-4 text-sm font-semibold text-ink-900 hover:border-kesari-600"
            >
              <Icon name="search" size={16} /> Enter PIN code or area
            </button>
          ) : null}
        </div>

        {problem ? (
          <div role="alert" className="mt-3 rounded-xl border-2 border-amber-300 bg-amber-50 p-3" data-testid="nearby-problem">
            <p className="text-sm font-bold text-ink-900">{PROBLEM_TEXT[problem].title}</p>
            <p className="mt-0.5 text-sm text-ink-700">{PROBLEM_TEXT[problem].detail}</p>
          </div>
        ) : null}

        {problem || manualOpen ? (
          <form onSubmit={searchPlace} className="mt-3 flex gap-2" role="search" data-testid="nearby-manual">
            <label className="flex h-12 min-w-0 flex-1 items-center gap-2 rounded-xl border-2 border-[var(--gk-line)] bg-white px-3 focus-within:border-kesari-600">
              <Icon name="map-pin" size={18} className="shrink-0 text-ink-600" />
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder="PIN code or area, e.g. 411014 or Kharadi"
                aria-label="PIN code or area"
                inputMode="text"
                autoComplete="postal-code"
                maxLength={80}
                className="h-full min-w-0 flex-1 bg-transparent text-base text-ink-900 placeholder:text-ink-600 focus:outline-none"
                data-testid="nearby-manual-input"
              />
            </label>
            <button type="submit" className="min-h-12 rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white hover:bg-kesari-800">
              Search
            </button>
          </form>
        ) : null}

        {error ? (
          <p role="alert" className="mt-2 text-sm font-semibold text-red-700" data-testid="nearby-error">
            {error}
          </p>
        ) : null}
      </section>

      {/* Radius and view */}
      {origin ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="group" aria-label="Distance" className="flex flex-wrap gap-1.5" data-testid="nearby-radius">
            {NEARBY_RADII_KM.map((km) => (
              <button
                key={km}
                type="button"
                onClick={() => chooseRadius(km)}
                aria-pressed={radius === km}
                className={clsx(
                  "inline-flex min-h-11 items-center gap-1.5 rounded-full border-2 px-3.5 text-sm font-bold",
                  radius === km ? "border-kesari-700 bg-kesari-700 text-white" : "border-[var(--gk-line)] bg-white text-ink-900 hover:border-kesari-600",
                )}
                data-testid={`nearby-radius-${km}`}
              >
                {km} km
                {counts[String(km)] != null ? (
                  <span
                    className={clsx(
                      "inline-grid h-5 min-w-5 place-items-center rounded-full px-1 text-xs tabular-nums",
                      radius === km ? "bg-white/25 text-white" : "bg-kesari-100 text-ink-900",
                    )}
                  >
                    {counts[String(km)]}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <div role="group" aria-label="View" className="flex rounded-full border-2 border-[var(--gk-line)] bg-white p-0.5" data-testid="nearby-view">
            {(["list", "map"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={clsx(
                  "inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-sm font-bold",
                  view === v ? "bg-ink-900 text-white" : "text-ink-900",
                )}
                data-testid={`nearby-view-${v}`}
              >
                <Icon name={v === "list" ? "layout-grid" : "map"} size={16} />
                {v === "list" ? "List" : "Map view"}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Results */}
      {origin && phase !== "locating" ? (
        shops.length === 0 && phase === "ready" ? (
          <section className="rounded-2xl border-2 border-dashed border-[var(--gk-line)] bg-white p-5 text-center" data-testid="nearby-empty">
            <p className="text-base font-bold text-ink-900">No shops found within {radius} km</p>
            {nextWithShops ? (
              <>
                <p className="mt-1 text-sm text-ink-700">
                  {counts[String(nextWithShops)]} shop{counts[String(nextWithShops)] === 1 ? "" : "s"} within {nextWithShops} km.
                </p>
                <button
                  type="button"
                  onClick={() => chooseRadius(nextWithShops)}
                  className="mt-3 inline-flex min-h-11 items-center rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white hover:bg-kesari-800"
                  data-testid="nearby-widen"
                >
                  Widen to {nextWithShops} km
                </button>
              </>
            ) : wider ? (
              <>
                <p className="mt-1 text-sm text-ink-700">There are no shops within {NEARBY_RADII_KM[NEARBY_RADII_KM.length - 1]} km either.</p>
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => chooseRadius(NEARBY_RADII_KM[NEARBY_RADII_KM.length - 1])}
                    className="inline-flex min-h-11 items-center rounded-xl border-2 border-[var(--gk-line)] px-4 text-sm font-bold text-ink-900"
                    data-testid="nearby-widen"
                  >
                    Widen to {NEARBY_RADII_KM[NEARBY_RADII_KM.length - 1]} km
                  </button>
                  <Link href="/shops?all=1" className="inline-flex min-h-11 items-center rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white">
                    See all shops
                  </Link>
                </div>
              </>
            ) : (
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <button type="button" onClick={() => setManualOpen(true)} className="inline-flex min-h-11 items-center rounded-xl border-2 border-[var(--gk-line)] px-4 text-sm font-bold text-ink-900">
                  Try another PIN code
                </button>
                <Link href="/shops?all=1" className="inline-flex min-h-11 items-center rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white">
                  See all shops
                </Link>
              </div>
            )}
          </section>
        ) : view === "map" ? (
          <NearbyMap origin={origin} radiusKm={radius} shops={shops} />
        ) : (
          <ul className={clsx("grid gap-2 sm:grid-cols-2 xl:grid-cols-3", phase === "loading" && "opacity-60")} data-testid="nearby-list" aria-busy={phase === "loading"}>
            {shops.map((shop) => (
              <li key={shop.id}>
                <NearbyShopCard shop={shop} />
              </li>
            ))}
          </ul>
        )
      ) : null}

      {phase === "locating" ? (
        <p className="rounded-2xl border-2 border-[var(--gk-line)] bg-white p-4 text-sm text-ink-700">
          Allow location when your browser or phone asks — it is used only to find shops near you, and kept on this device as your delivery location if you have not chosen one.
        </p>
      ) : null}
    </div>
  );
}

export function NearbyShopCard({ shop, compact = false }: { shop: NearbyShop; compact?: boolean }) {
  return (
    <article className="flex h-full flex-col gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3" data-testid="nearby-shop">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-kesari-100 text-kesari-700">
          <Icon name="store" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-bold text-ink-900">
            <Link href={`/shops/${encodeURIComponent(shop.slug)}`} className="hover:underline">
              {shop.name}
            </Link>
          </h3>
          <p className="truncate text-sm text-ink-700">{shop.shopTypeLabel}</p>
        </div>
        <span className="shrink-0 rounded-full bg-[var(--gk-chip)] px-2.5 py-1 text-sm font-bold tabular-nums text-ink-900" data-testid="nearby-distance">
          {shop.distanceText}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold">
        <span
          className={clsx("rounded-full px-2 py-0.5", shop.open ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800")}
          data-testid="nearby-open"
        >
          {shop.open ? "Open now" : "Closed"}
        </span>
        {!shop.takingOrders ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">Not taking orders</span> : null}
        {!compact && (shop.area || shop.city) ? (
          <span className="truncate font-medium text-ink-600">{[shop.area, shop.city].filter(Boolean).join(", ")}</span>
        ) : null}
      </div>
      <div className="mt-auto flex gap-2">
        <a
          href={shop.directionsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-kesari-700 px-3 text-sm font-bold text-white hover:bg-kesari-800"
          data-testid="nearby-directions"
        >
          <Icon name="route" size={16} /> Directions
        </a>
        <Link
          href={`/shops/${encodeURIComponent(shop.slug)}`}
          className="inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-[var(--gk-line)] px-3 text-sm font-bold text-ink-900 hover:border-kesari-600"
        >
          View shop
        </Link>
      </div>
    </article>
  );
}
