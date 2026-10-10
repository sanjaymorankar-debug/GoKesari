"use client";

/**
 * "Map view" of Nearby (docs/nearby-referral-2026-10, feature 1): the user's
 * position and every nearby shop as a pin; tapping a pin shows the shop's
 * name, distance and Directions.
 *
 * With the browser Maps key (NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) it is a Google
 * map — one Maps JS load, only when someone opens Map view (MAPS_USAGE.md).
 * Without the key, or if Google fails to load, it draws its own map: the same
 * pins to scale around the user, with distance rings — no streets, but every
 * pin, distance and Directions link still works and nothing is fetched.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";

import { NearbyShopCard, type NearbyShop } from "@/components/nearby-shops";
import { isMapsAvailable, loadGoogleMaps } from "@/lib/geo/provider";

interface Props {
  origin: { latitude: number; longitude: number };
  radiusKm: number;
  shops: NearbyShop[];
}

export function NearbyMap({ origin, radiusKm, shops }: Props) {
  const [google, setGoogle] = useState<"loading" | "ready" | "off">(isMapsAvailable() ? "loading" : "off");
  const [selected, setSelected] = useState<string | null>(null);
  const chosen = shops.find((s) => s.id === selected) ?? null;

  return (
    <section className="flex flex-col gap-2" data-testid="nearby-map">
      {google !== "off" ? (
        <GoogleNearbyMap origin={origin} radiusKm={radiusKm} shops={shops} selected={selected} onSelect={setSelected} onState={setGoogle} />
      ) : (
        <DrawnNearbyMap origin={origin} radiusKm={radiusKm} shops={shops} selected={selected} onSelect={setSelected} />
      )}
      <p className="text-xs text-ink-600">
        {google === "off" ? "Simple map: you are in the centre; rings show the distance. " : ""}
        Tap a pin to see the shop.
      </p>
      {chosen ? (
        <div data-testid="nearby-map-selected">
          <NearbyShopCard shop={chosen} compact />
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------ Google map */

function GoogleNearbyMap({
  origin,
  radiusKm,
  shops,
  selected,
  onSelect,
  onState,
}: Props & { selected: string | null; onSelect: (id: string | null) => void; onState: (s: "loading" | "ready" | "off") => void }) {
  const div = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const markers = useRef<Map<string, google.maps.Marker>>(new Map());
  const overlays = useRef<{ me?: google.maps.Marker; ring?: google.maps.Circle; info?: google.maps.InfoWindow }>({});
  const [ready, setReady] = useState(false);

  // The map itself: once.
  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps()
      .then(() => {
        if (cancelled || !div.current || map.current) return;
        map.current = new window.google!.maps.Map(div.current, {
          center: { lat: origin.latitude, lng: origin.longitude },
          zoom: 14,
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
          clickableIcons: false,
        });
        overlays.current.info = new window.google!.maps.InfoWindow();
        overlays.current.info.addListener("closeclick", () => onSelect(null));
        setReady(true);
        onState("ready");
      })
      .catch(() => {
        if (!cancelled) onState("off");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The user, the radius ring and the shop pins: whenever they change.
  useEffect(() => {
    const m = map.current;
    const g = window.google?.maps;
    if (!m || !g) return;
    const centre = { lat: origin.latitude, lng: origin.longitude };
    overlays.current.me?.setMap(null);
    overlays.current.ring?.setMap(null);
    overlays.current.me = new g.Marker({
      position: centre,
      map: m,
      title: "You are here",
      zIndex: 1000,
      icon: { path: g.SymbolPath.CIRCLE, scale: 9, fillColor: "#1d4ed8", fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 3 },
    });
    overlays.current.ring = new g.Circle({
      map: m,
      center: centre,
      radius: radiusKm * 1000,
      strokeColor: "#c2410c",
      strokeOpacity: 0.6,
      strokeWeight: 2,
      fillColor: "#fdba74",
      fillOpacity: 0.08,
      clickable: false,
    });
    for (const marker of markers.current.values()) marker.setMap(null);
    markers.current.clear();
    const bounds = new g.LatLngBounds();
    bounds.extend(centre);
    for (const shop of shops) {
      const position = { lat: shop.latitude, lng: shop.longitude };
      const marker = new g.Marker({ position, map: m, title: `${shop.name} · ${shop.distanceText}` });
      marker.addListener("click", () => onSelect(shop.id));
      markers.current.set(shop.id, marker);
      bounds.extend(position);
    }
    if (shops.length > 0) m.fitBounds(bounds, 48);
    else m.fitBounds(overlays.current.ring.getBounds()!, 24);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin.latitude, origin.longitude, radiusKm, shops, ready]);

  // The info bubble for the tapped pin: built from DOM nodes, so a shop's name is never read as HTML.
  useEffect(() => {
    const info = overlays.current.info;
    const shop = shops.find((s) => s.id === selected);
    const marker = selected ? markers.current.get(selected) : undefined;
    if (!info) return;
    if (!shop || !marker) {
      info.close();
      return;
    }
    const box = document.createElement("div");
    box.style.cssText = "font: 14px system-ui, sans-serif; max-width: 220px; color: #0f172a";
    const name = document.createElement("strong");
    name.textContent = shop.name;
    const line = document.createElement("div");
    line.textContent = `${shop.distanceText} away · ${shop.open ? "Open now" : "Closed"}`;
    line.style.cssText = "margin: 2px 0 8px; color: #334155";
    const link = document.createElement("a");
    link.href = shop.directionsUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Directions";
    link.setAttribute("data-testid", "nearby-map-directions");
    link.style.cssText =
      "display: inline-block; padding: 8px 14px; border-radius: 10px; background: #c2410c; color: #fff; font-weight: 700; text-decoration: none";
    box.append(name, line, link);
    info.setContent(box);
    info.open({ map: map.current!, anchor: marker });
  }, [selected, shops, ready]);

  return <div ref={div} className="h-[60vh] min-h-72 w-full overflow-hidden rounded-2xl border-2 border-[var(--gk-line)] bg-cream-100" data-testid="nearby-google-map" />;
}

/* ------------------------------------------------- drawn map (no Google) */

const SIZE = 320;
const KM_PER_DEG_LAT = 111.32;

function DrawnNearbyMap({ origin, radiusKm, shops, selected, onSelect }: Props & { selected: string | null; onSelect: (id: string | null) => void }) {
  const scale = (SIZE / 2 - 16) / radiusKm; // px per km
  const pins = useMemo(
    () =>
      shops.map((shop) => {
        const east = (shop.longitude - origin.longitude) * KM_PER_DEG_LAT * Math.cos((origin.latitude * Math.PI) / 180);
        const north = (shop.latitude - origin.latitude) * KM_PER_DEG_LAT;
        return { shop, x: SIZE / 2 + east * scale, y: SIZE / 2 - north * scale };
      }),
    [shops, origin.latitude, origin.longitude, scale],
  );
  const rings = [radiusKm / 2, radiusKm];

  return (
    <div className="mx-auto w-full max-w-xl rounded-2xl border-2 border-[var(--gk-line)] bg-[#fffaf3] p-2" data-testid="nearby-drawn-map">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-auto w-full" role="group" aria-label={`Map of ${shops.length} shops within ${radiusKm} km`}>
        {rings.map((r) => (
          <g key={r}>
            <circle cx={SIZE / 2} cy={SIZE / 2} r={r * scale} fill={r === radiusKm ? "#fff1e2" : "none"} stroke="#f0b47e" strokeDasharray={r === radiusKm ? undefined : "4 4"} />
            <text x={SIZE / 2 + 4} y={SIZE / 2 - r * scale + 12} fontSize="10" fill="#7c2d12">
              {r < 1 ? `${Math.round(r * 1000)} m` : `${r} km`}
            </text>
          </g>
        ))}
        <text x={SIZE / 2} y="12" fontSize="10" textAnchor="middle" fill="#475569">N</text>
        {pins.map(({ shop, x, y }) => {
          const active = shop.id === selected;
          return (
            <g
              key={shop.id}
              role="button"
              tabIndex={0}
              aria-label={`${shop.name}, ${shop.distanceText}`}
              aria-pressed={active}
              onClick={() => onSelect(active ? null : shop.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(active ? null : shop.id);
                }
              }}
              className="cursor-pointer focus:outline-none"
              data-testid="nearby-map-pin"
            >
              {/* A larger, invisible target so a finger can hit it. */}
              <circle cx={x} cy={y - 8} r="16" fill="transparent" />
              <path
                d={`M ${x} ${y} l -7 -11 a 8.5 8.5 0 1 1 14 0 z`}
                className={clsx(active ? "fill-red-700" : "fill-kesari-700")}
                stroke="#fff"
                strokeWidth="1.5"
              />
              <circle cx={x} cy={y - 14} r="3" fill="#fff" />
            </g>
          );
        })}
        <circle cx={SIZE / 2} cy={SIZE / 2} r="12" fill="#1d4ed8" opacity="0.18" />
        <circle cx={SIZE / 2} cy={SIZE / 2} r="6" fill="#1d4ed8" stroke="#fff" strokeWidth="2" data-testid="nearby-map-me">
          <title>You are here</title>
        </circle>
      </svg>
    </div>
  );
}
