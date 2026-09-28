"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, inputClass } from "@/components/ui";

/**
 * "Deliver to" chooser (GS-004). Three ways to set the location discovery
 * uses: a saved address, the device's position, or a typed PIN code. The
 * choice is kept server-side in an httpOnly cookie (POST /api/location), so
 * this component only sends it and refreshes the page.
 */
export function LocationPicker({
  currentLabel,
  savedAddresses,
}: {
  currentLabel: string | null;
  savedAddresses: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(currentLabel == null);
  const [pincode, setPincode] = useState("");
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
      setOpen(false);
      setPincode("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That location could not be used.");
    } finally {
      setBusy(false);
    }
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
    <div className="mb-6 rounded-xl border border-cream-200 bg-white p-3" data-testid="location-picker">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-700">
          <span className="text-ink-500">Deliver to: </span>
          <span className="font-medium" data-testid="location-label">
            {currentLabel ?? "Choose your location to see shops that deliver to you"}
          </span>
        </p>
        <div className="flex gap-2">
          {currentLabel ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => choose(null)}>
              Clear
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" onClick={() => setOpen((v) => !v)}>
            {open ? "Close" : "Change"}
          </Button>
        </div>
      </div>

      {open ? (
        <div className="mt-3 space-y-3 border-t border-cream-200 pt-3">
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
            <Button size="sm" disabled={busy} onClick={useDevice}>
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
              <Button size="sm" type="submit" variant="secondary" disabled={busy}>
                Use PIN
              </Button>
            </form>
          </div>

          {error ? <Alert tone="warning">{error}</Alert> : null}
        </div>
      ) : null}
    </div>
  );
}
