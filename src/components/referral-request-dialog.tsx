"use client";

import { useEffect, useState } from "react";

import { Alert, Button, Field, inputClass } from "@/components/ui";
import { checkReferralRequest } from "@/lib/referral-requests";
import { SHOP_TYPES } from "@/lib/shop-types";

type LocationState =
  | { status: "asking" }
  | { status: "shared"; latitude: number; longitude: number; accuracyM: number | null }
  | { status: "denied" }
  | { status: "unavailable" };

export interface ReferralRequestPrefill {
  name?: string;
  mobile?: string;
  shopType?: string;
  area?: string;
  city?: string;
  pincode?: string;
}

/**
 * "Request a referral code" (docs/four-features-2026-10, feature 4). Asks the
 * browser (or app) for the person's location first — latitude, longitude and
 * a Google Maps link — and works just as well when they say no: the request
 * then carries only the address they type, marked "location not shared".
 */
export function ReferralRequestDialog({ prefill, onClose }: { prefill: ReferralRequestPrefill; onClose: () => void }) {
  const [location, setLocation] = useState<LocationState>({ status: "asking" });
  const [values, setValues] = useState({
    name: prefill.name ?? "",
    mobile: prefill.mobile ?? "",
    shopType: prefill.shopType ?? "",
    area: prefill.area ?? "",
    city: prefill.city ?? "",
    pincode: prefill.pincode ?? "",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ reference: string; mobileMasked: string; locationShared: boolean } | null>(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      // No geolocation in this browser: the request goes without it.
      queueMicrotask(() => setLocation({ status: "unavailable" }));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setLocation({
          status: "shared",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyM: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null,
        }),
      (failure) => setLocation({ status: failure.code === failure.PERMISSION_DENIED ? "denied" : "unavailable" }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }, []);

  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((v) => ({ ...v, [key]: key === "mobile" || key === "pincode" ? e.target.value.replace(/\D/g, "").slice(0, key === "mobile" ? 10 : 6) : e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const coords = location.status === "shared" ? { latitude: location.latitude, longitude: location.longitude, accuracyM: location.accuracyM } : {};
    const local = checkReferralRequest({ ...values, ...coords });
    if (!local.ok) {
      setFieldErrors(local.fields);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    try {
      const response = await fetch("/api/referral-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, ...coords }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setFieldErrors(payload?.error?.details?.fields ?? {});
        throw new Error(payload?.error?.message ?? "Could not send the request.");
      }
      setDone(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the request.");
    } finally {
      setBusy(false);
    }
  }

  const mapsUrl = location.status === "shared" ? `https://www.google.com/maps?q=${location.latitude.toFixed(6)},${location.longitude.toFixed(6)}` : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Request a referral code">
      <div className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:max-w-lg sm:rounded-2xl" data-testid="referral-request-dialog">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold text-ink-900">Request a referral code</h2>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-ink-500 hover:bg-cream-100" aria-label="Close">
            ✕
          </button>
        </div>

        {done ? (
          <div className="mt-4 space-y-3" data-testid="referral-request-done">
            <Alert tone="success" title="Request received">
              Thank you! Your request {done.reference} has reached our referrals team. We will call or message you on {done.mobileMasked}
              {" "}with your referral code, usually within one working day.
            </Alert>
            {!done.locationShared ? <p className="text-xs text-ink-500">Your location was not shared, so we will use the address you gave.</p> : null}
            <Button onClick={onClose}>Close</Button>
          </div>
        ) : (
          <>
            <p className="mt-1 text-sm text-ink-600">No referral code yet? Tell us about your shop and our team will send you one.</p>
            <div className="mt-3 rounded-lg bg-cream-50 px-3 py-2 text-sm" data-testid="referral-request-location">
              {location.status === "asking" ? (
                <span className="text-ink-600">Asking your browser for your location… allow it to help us find your shop.</span>
              ) : location.status === "shared" ? (
                <span className="text-leaf-700">
                  Location captured ({location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}).{" "}
                  <a href={mapsUrl!} target="_blank" rel="noreferrer" className="underline">
                    See on Google Maps
                  </a>
                </span>
              ) : (
                <span className="text-amber-800">
                  Location not shared{location.status === "denied" ? " (permission denied)" : ""} — that is fine, just enter your address below.
                </span>
              )}
            </div>
            <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={submit} noValidate>
              <Field label="Your name" error={fieldErrors.name}>
                <input className={inputClass} value={values.name} onChange={set("name")} autoComplete="name" aria-label="Your name" />
              </Field>
              <Field label="Mobile number" error={fieldErrors.mobile}>
                <input className={inputClass} value={values.mobile} onChange={set("mobile")} inputMode="numeric" autoComplete="tel-national" aria-label="Mobile number" />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Type of shop" error={fieldErrors.shopType}>
                  <select className={inputClass} value={values.shopType} onChange={set("shopType")} aria-label="Type of shop">
                    <option value="" disabled>
                      Select a shop type
                    </option>
                    {SHOP_TYPES.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Area / locality" error={fieldErrors.area}>
                <input className={inputClass} value={values.area} onChange={set("area")} aria-label="Area" />
              </Field>
              <Field label="City" error={fieldErrors.city}>
                <input className={inputClass} value={values.city} onChange={set("city")} aria-label="City" />
              </Field>
              <Field label="PIN code" hint="6 digits" error={fieldErrors.pincode}>
                <input className={inputClass} value={values.pincode} onChange={set("pincode")} inputMode="numeric" aria-label="PIN code" />
              </Field>
              {fieldErrors.location ? <p className="text-xs text-red-600 sm:col-span-2">{fieldErrors.location}</p> : null}
              {error ? (
                <div className="sm:col-span-2">
                  <Alert tone="danger">{error}</Alert>
                </div>
              ) : null}
              <div className="flex gap-2 sm:col-span-2">
                {/* Never blocked on the location prompt: still waiting means it is sent without one. */}
                <Button type="submit" disabled={busy}>
                  {busy ? "Sending…" : "Send request"}
                </Button>
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
