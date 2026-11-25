"use client";

/**
 * My Zone map: the rider's working radius (orange ring), their societies (green pins) and busy
 * areas (red circles, sized by order count — counts only, area centres rounded to ~1 km).
 * One Maps JS load when the page opens (MAPS_USAGE.md). Without the browser key, or if Google
 * refuses it, nothing is drawn and the page shows the lists only.
 */
import { useEffect, useRef, useState } from "react";

import { isMapsAvailable, loadGoogleMaps, onMapsAuthFailure } from "@/lib/geo/provider";

interface Point {
  latitude: number;
  longitude: number;
}

export interface ZoneMapProps {
  centre: Point;
  radiusKm: number;
  societies: { id: string; name: string; latitude: number | null; longitude: number | null }[];
  hotspots: { key: string; label: string; orders: number; latitude: number | null; longitude: number | null }[];
  note: string;
}

export function ZoneMap({ centre, radiusKm, societies, hotspots, note }: ZoneMapProps) {
  const div = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "off">(isMapsAvailable() ? "loading" : "off");
  useEffect(() => onMapsAuthFailure(() => setState("off")), []);

  useEffect(() => {
    if (!isMapsAvailable()) return;
    let cancelled = false;
    loadGoogleMaps()
      .then(() => {
        const g = window.google?.maps;
        if (cancelled || !div.current || !g) return;
        const centrePos = { lat: centre.latitude, lng: centre.longitude };
        const map = new g.Map(div.current, {
          center: centrePos,
          zoom: 13,
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
          clickableIcons: false,
        });
        new g.Marker({
          position: centrePos,
          map,
          title: "You",
          zIndex: 1000,
          icon: { path: g.SymbolPath.CIRCLE, scale: 8, fillColor: "#1d4ed8", fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 3 },
        });
        const ring = new g.Circle({
          map,
          center: centrePos,
          radius: radiusKm * 1000,
          strokeColor: "#c2410c",
          strokeOpacity: 0.7,
          strokeWeight: 2,
          fillColor: "#fdba74",
          fillOpacity: 0.08,
          clickable: false,
        });
        for (const s of societies) {
          if (s.latitude == null || s.longitude == null) continue;
          new g.Marker({
            position: { lat: s.latitude, lng: s.longitude },
            map,
            title: s.name,
            icon: { path: g.SymbolPath.CIRCLE, scale: 7, fillColor: "#15803d", fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 2 },
          });
        }
        for (const h of hotspots) {
          if (h.latitude == null || h.longitude == null) continue;
          new g.Circle({
            map,
            center: { lat: h.latitude, lng: h.longitude },
            radius: Math.min(1200, 300 + h.orders * 120),
            strokeColor: "#b91c1c",
            strokeOpacity: 0.6,
            strokeWeight: 1,
            fillColor: "#ef4444",
            fillOpacity: 0.25,
            clickable: false,
          });
        }
        const bounds = ring.getBounds();
        if (bounds) map.fitBounds(bounds, 16);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("off");
      });
    return () => {
      cancelled = true;
    };
  }, [centre.latitude, centre.longitude, radiusKm, societies, hotspots]);

  if (state === "off") return null;
  return (
    <div className="space-y-1">
      <div ref={div} className="h-[50vh] min-h-64 w-full overflow-hidden rounded-2xl border-2 border-cream-200 bg-cream-100" data-testid="rider-zone-map" />
      <p className="text-xs text-ink-600">{note}</p>
    </div>
  );
}
