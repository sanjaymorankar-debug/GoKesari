"use client";
import { useEffect, useRef, useState } from "react";

import { isMapsAvailable, loadGoogleMaps } from "@/lib/geo/provider";

export interface AreaShape {
  zoneId: string;
  shape: "NONE" | "POLYGON" | "CIRCLE";
  centre: [number, number] | null;
  radiusM: number | null;
  polygon: [number, number][] | null;
}

/**
 * Shows franchise zones on a map (the dealer's zones on his franchise page).
 * Given `shapes`, or `zoneIds` to look up from the public zones GeoJSON. Falls back to a text message.
 */
export function AreaMap({ shapes, zoneIds, height = 320 }: { shapes?: AreaShape[]; zoneIds?: string[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | null>(isMapsAvailable() ? null : "The map is not available on this site.");
  const key = JSON.stringify(shapes ?? zoneIds ?? []);
  useEffect(() => {
    if (!box.current || !isMapsAvailable()) return;
    let cancelled = false;
    (async () => {
      try {
        await loadGoogleMaps();
        if (cancelled || !box.current) return;
        const map = new google.maps.Map(box.current, { center: { lat: 18.55, lng: 73.86 }, zoom: 11, mapTypeControl: false, streetViewControl: false });
        const bounds = new google.maps.LatLngBounds();
        let drawn = 0;
        const style = { strokeColor: "#c2410c", strokeWeight: 2, fillColor: "#f97316", fillOpacity: 0.15, map };
        if (shapes) {
          for (const s of shapes) {
            if (s.shape === "CIRCLE" && s.centre && s.radiusM) {
              const c = new google.maps.Circle({ ...style, center: { lat: s.centre[0], lng: s.centre[1] }, radius: s.radiusM });
              const b = c.getBounds();
              if (b) bounds.union(b);
              drawn++;
            } else if (s.shape === "POLYGON" && s.polygon?.length) {
              const path = s.polygon.map(([lat, lng]) => ({ lat, lng }));
              new google.maps.Polygon({ ...style, paths: path });
              path.forEach((p) => bounds.extend(p));
              drawn++;
            }
            if (s.centre) new google.maps.Marker({ map, position: { lat: s.centre[0], lng: s.centre[1] }, label: s.zoneId });
          }
        } else if (zoneIds?.length) {
          const geo = await (await fetch("/api/franchise/boundaries")).json();
          const wanted = new Set(zoneIds);
          const features = map.data.addGeoJson({ ...geo, features: (geo.features ?? []).filter((f: { properties?: { zone_id?: string } }) => wanted.has(String(f.properties?.zone_id))) });
          map.data.setStyle({ fillColor: "#f97316", fillOpacity: 0.15, strokeColor: "#c2410c", strokeWeight: 2 });
          features.forEach((f) => f.getGeometry()?.forEachLatLng((p) => bounds.extend(p)));
          drawn = features.length;
        }
        if (drawn) map.fitBounds(bounds);
        else setProblem("No approved boundary to show yet.");
      } catch {
        if (!cancelled) setProblem("The map could not be loaded.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <div className="space-y-1">
      <div ref={box} style={{ height }} className="w-full rounded-xl border border-cream-200 bg-cream-50" aria-label="Map of franchise areas" />
      {problem ? <p className="text-xs text-ink-500">{problem}</p> : <p className="text-xs text-ink-500">The shaded shape is your franchise zone. A shop belongs to it when its area (chosen at registration) is one of the zone&apos;s areas.</p>}
    </div>
  );
}
