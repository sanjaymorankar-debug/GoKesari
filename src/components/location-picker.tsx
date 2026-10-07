"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { MapPickerResult } from "@/components/map-picker";
import { Alert, Button, inputClass } from "@/components/ui";
import { isMapsAvailable } from "@/lib/geo/provider";

// Only needed once someone opens "Search an address", so the map picker (and
// the Google Maps loader behind it) stays out of every page's initial bundle.
const MapPicker = dynamic(() => import("@/components/map-picker").then((m) => m.MapPicker), {
  ssr: false,
});

/** Other parts of a page ask the header to open the chooser with this event. */
export const OPEN_LOCATION_EVENT = "gk:open-location";

/**
 * The header's "Deliver to" pill (GS-004): shows the chosen place and opens
 * the chooser. Without a location it invites the visitor to pick one.
 */
export function DeliverToPill({
  label,
  open,
  onToggle,
}: {
  label: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="location-panel"
      data-testid="location-pill"
      className="tap-target flex min-w-0 max-w-[11rem] shrink items-center gap-2 rounded-xl border border-kesari-300 bg-kesari-50 px-2.5 py-1.5 text-left hover:bg-kesari-100 sm:max-w-[13rem] [--tap-h:44px]"
    >
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden className="shrink-0 text-kesari-600">
        <path
          d="M10 18s6-5.2 6-9.6A6 6 0 0 0 4 8.4C4 12.8 10 18 10 18Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <circle cx="10" cy="8.4" r="2.1" stroke="currentColor" strokeWidth="1.6" />
      </svg>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="text-[11px] font-medium text-kesari-700">Deliver to</span>
        <span className="truncate text-sm font-semibold text-ink-900" data-testid="location-label">
          {label ?? "Choose location"}
        </span>
      </span>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={`shrink-0 text-kesari-700 transition-transform ${open ? "rotate-180" : ""}`}>
        <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/**
 * The chooser itself, shown as a row under the header. Three ways to set the
 * location discovery uses: a saved address, the device's position, or a typed
 * PIN code (plus an address search where Maps is configured). The choice is
 * kept server-side in an httpOnly cookie (POST /api/location), so this
 * component only sends it and refreshes the page.
 */
export function LocationPanel({
  currentLabel,
  savedAddresses,
  onClose,
}: {
  currentLabel: string | null;
  savedAddresses: { id: string; label: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pincode, setPincode] = useState("");
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(body: Record<string, unknown> | null) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/location", {
        method: body ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "That location could not be used.");
      }
      setPincode("");
      onClose();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That location could not be used.");
    } finally {
      setBusy(false);
    }
  }

  /** A searched/pinned address: coordinates plus the PIN found in the formatted address. */
  function useSearchedAddress(result: MapPickerResult) {
    const pin = result.formattedAddress.match(/\d{6}/)?.[0];
    void choose({
      latitude: result.latitude,
      longitude: result.longitude,
      pincode: pin ?? null,
      label: result.formattedAddress.slice(0, 120),
    });
  }

  function useDevice() {
    if (!("geolocation" in navigator)) {
      setError("This device cannot share its location — enter a PIN code instead.");
      return;
    }
    setBusy(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) =>
        void choose({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      () => {
        setBusy(false);
        setError("Location permission was not given — enter a PIN code instead.");
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  }

  return (
    <div id="location-panel" className="border-t border-cream-200 bg-white" data-testid="location-picker">
      <div className="mx-auto w-full max-w-6xl space-y-3 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-ink-700">
            <span className="text-ink-500">Deliver to: </span>
            <span className="font-medium">
              {currentLabel ?? "Choose your location to see shops near you"}
            </span>
          </p>
          <div className="flex gap-2">
            {currentLabel ? (
              <Button size="sm" variant="ghost" className="tap-target" disabled={busy} onClick={() => choose(null)}>
                Clear
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" className="tap-target" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>

        {savedAddresses.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {savedAddresses.map((a) => (
              <Button
                key={a.id}
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => choose({ addressId: a.id })}
              >
                {a.label}
              </Button>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {/* Rows here are 8px apart, so 36px keeps the tap areas apart. */}
          <Button size="sm" className="tap-target [--tap-h:36px]" disabled={busy} onClick={useDevice}>
            Use my current location
          </Button>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void choose({ pincode: pincode.trim() });
            }}
          >
            <input
              className={`${inputClass} w-32`}
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              required
              placeholder="PIN code"
              aria-label="PIN code"
              value={pincode}
              onChange={(e) => setPincode(e.target.value.replace(/\D/g, ""))}
            />
            <Button size="sm" type="submit" variant="secondary" className="tap-target" disabled={busy}>
              Use PIN
            </Button>
          </form>
        </div>

        <div>
          {isMapsAvailable() ? (
            <>
              <Button size="sm" variant="secondary" className="tap-target [--tap-h:36px]" onClick={() => setSearching((v) => !v)}>
                {searching ? "Hide address search" : "Search an address"}
              </Button>
              {searching ? (
                <div className="mt-2">
                  <MapPicker purpose="location_search" onConfirm={useSearchedAddress} />
                </div>
              ) : null}
            </>
          ) : null}
          <p className="mt-2 text-xs text-ink-500">
            Want to keep this place? <a href="/profile/addresses" className="underline">Save it as an address</a> to
            reuse it at checkout.
          </p>
        </div>

        {error ? <Alert tone="warning">{error}</Alert> : null}
      </div>
    </div>
  );
}

/**
 * A link-styled button that opens the header's location chooser — for
 * "Change location" and "Choose your location" prompts inside a page.
 */
export function OpenLocationButton({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className ?? "font-medium text-kesari-600 underline hover:text-kesari-800"}
      onClick={() => window.dispatchEvent(new Event(OPEN_LOCATION_EVENT))}
    >
      {children}
    </button>
  );
}
