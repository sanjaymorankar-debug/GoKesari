"use client";

import { useEffect, useRef, useState } from "react";

import { Alert, Button, inputClass } from "@/components/ui";
import {
  getCurrentPosition,
  isMapsAvailable,
  loadGoogleMaps,
} from "@/lib/geo/provider";

export interface MapPickerResult {
  latitude: number;
  longitude: number;
  formattedAddress: string;
}

const DEFAULT_CENTER = { lat: 18.5204, lng: 73.8567 }; // Pune — a sane default, not a claim about the user's location

/**
 * Reusable map location picker: search-as-you-type, current-location
 * button, draggable pin, and a "Confirm location" action. Used by both shop
 * registration and customer address forms.
 *
 * Renders nothing but a manual-entry notice if Google Maps isn't configured
 * (NEXT_PUBLIC_GOOGLE_MAPS_API_KEY unset) — the calling form must still work
 * with plain text fields in that case; this component is purely additive.
 */
export function MapPicker({
  initialCoordinates,
  purpose,
  onConfirm,
}: {
  initialCoordinates?: { latitude: number; longitude: number } | null;
  /** Logged with the one server-side geocode call — e.g. "shop_registration", "address_save". */
  purpose: string;
  onConfirm: (result: MapPickerResult) => void;
}) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(
    initialCoordinates
      ? { lat: initialCoordinates.latitude, lng: initialCoordinates.longitude }
      : null,
  );

  useEffect(() => {
    if (!isMapsAvailable()) return;
    let cancelled = false;

    loadGoogleMaps()
      .then(() => {
        if (cancelled || !mapDivRef.current) return;

        const center = pin ?? DEFAULT_CENTER;
        const map = new google.maps.Map(mapDivRef.current, {
          center,
          zoom: pin ? 16 : 12,
          streetViewControl: false,
          mapTypeControl: false,
        });
        const marker = new google.maps.Marker({
          position: center,
          map,
          draggable: true,
        });
        marker.addListener("dragend", () => {
          const pos = marker.getPosition();
          if (pos) setPin({ lat: pos.lat(), lng: pos.lng() });
        });
        map.addListener("click", (e: google.maps.MapMouseEvent) => {
          if (!e.latLng) return;
          marker.setPosition(e.latLng);
          setPin({ lat: e.latLng.lat(), lng: e.latLng.lng() });
        });

        mapRef.current = map;
        markerRef.current = marker;

        if (searchInputRef.current) {
          const autocomplete = new google.maps.places.Autocomplete(searchInputRef.current, {
            fields: ["geometry"],
          });
          autocomplete.addListener("place_changed", () => {
            const place = autocomplete.getPlace();
            const location = place.geometry?.location;
            if (!location) return;
            const next = { lat: location.lat(), lng: location.lng() };
            map.setCenter(next);
            map.setZoom(16);
            marker.setPosition(next);
            setPin(next);
          });
        }

        setReady(true);
      })
      .catch(() => setError("Could not load the map. You can still enter the address manually."));

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function useCurrentLocation() {
    setBusy(true);
    setError(null);
    try {
      const coords = await getCurrentPosition();
      const next = { lat: coords.latitude, lng: coords.longitude };
      setPin(next);
      mapRef.current?.setCenter(next);
      mapRef.current?.setZoom(16);
      markerRef.current?.setPosition(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not get your location.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!pin) {
      setError("Search, drop a pin, or use your current location first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/geo/verify-location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latitude: pin.lat, longitude: pin.lng, purpose }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "Could not confirm this location.");
      }
      onConfirm({ latitude: pin.lat, longitude: pin.lng, formattedAddress: payload.formattedAddress });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not confirm this location.");
    } finally {
      setBusy(false);
    }
  }

  if (!isMapsAvailable()) {
    // No map without a Google Maps key, but the device's location can still geo-tag the address.
    return (
      <div className="space-y-2">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const coords = await getCurrentPosition();
              onConfirm({ latitude: coords.latitude, longitude: coords.longitude, formattedAddress: "" });
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : "Could not get your location.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Locating…" : "Use my current location"}
        </Button>
        <p className="text-xs text-ink-500">
          The map isn&apos;t available here — stand at the address and use your current location, then fill in the
          fields below.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex gap-2">
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search for an address"
          className={inputClass}
          disabled={!ready}
        />
        <Button type="button" variant="secondary" onClick={useCurrentLocation} disabled={busy || !ready}>
          Use my current location
        </Button>
      </div>
      <div ref={mapDivRef} className="h-64 w-full rounded-lg border border-cream-200" />
      <Button type="button" onClick={confirm} disabled={busy || !pin}>
        {busy ? "Confirming…" : "Confirm location"}
      </Button>
    </div>
  );
}
