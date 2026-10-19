"use client";

/**
 * "Deliver to" chooser (docs/homepage-uiux-2026-10, F6): a bottom sheet on
 * phones, a dialog on wide screens. Three ways to set the location discovery
 * uses — the device's position (GPS), a saved address, or a typed PIN code —
 * through the same POST /api/location as the header's panel. Choosing one
 * refreshes the page, so shops, banners and "Popular in your area" follow.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/board/icons";
import { tr, type Lang } from "@/lib/board/i18n";
import { HOME } from "@/lib/home-i18n";

export function LocationSheet({
  lang,
  currentLabel,
  savedAddresses,
  signedIn,
  onClose,
}: {
  lang: Lang;
  currentLabel: string | null;
  savedAddresses: { id: string; label: string }[];
  signedIn: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [pincode, setPincode] = useState("");
  const [busy, setBusy] = useState<"gps" | "pin" | string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Escape closes; focus moves into the sheet and the page behind stops scrolling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.querySelector<HTMLElement>("button, input")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  async function choose(body: Record<string, unknown> | null, which: string) {
    setBusy(which);
    setError(null);
    try {
      const response = await fetch("/api/location", {
        method: body ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? tr(HOME.locationFailed, lang));
      onClose();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : tr(HOME.locationFailed, lang));
    } finally {
      setBusy(null);
    }
  }

  function useDevice() {
    if (!("geolocation" in navigator)) {
      setError(tr(HOME.noGeolocation, lang));
      return;
    }
    setBusy("gps");
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => void choose({ latitude: position.coords.latitude, longitude: position.coords.longitude }, "gps"),
      () => {
        setBusy(null);
        setError(tr(HOME.locationDenied, lang));
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  }

  // In a portal: the sticky header is its own stacking context, which would keep the sheet under the bottom navigation.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center lg:items-center" data-testid="location-sheet">
      <button type="button" aria-label={tr(HOME.close, lang)} tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-ink-900/40" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="location-sheet-title"
        className="relative max-h-[85svh] w-full overflow-y-auto rounded-t-2xl bg-white px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-2 shadow-2xl lg:max-w-md lg:rounded-2xl lg:pb-4"
      >
        <span aria-hidden className="mx-auto mb-2 block h-1.5 w-10 rounded-full bg-cream-200 lg:hidden" />
        <div className="flex items-center justify-between gap-2">
          <h2 id="location-sheet-title" className="text-lg font-bold text-ink-900">
            {tr(HOME.chooseDeliveryLocation, lang)}
          </h2>
          <button type="button" onClick={onClose} aria-label={tr(HOME.close, lang)} className="grid h-11 w-11 place-items-center rounded-xl text-ink-700 hover:bg-cream-100">
            <Icon name="x" size={20} />
          </button>
        </div>
        {currentLabel ? (
          <p className="mb-3 text-sm text-ink-700">
            <span className="text-ink-600">{tr(HOME.deliverTo, lang)}: </span>
            <strong className="font-semibold">{currentLabel}</strong>
          </p>
        ) : null}

        <button
          type="button"
          onClick={useDevice}
          disabled={busy !== null}
          data-testid="location-gps"
          className="flex min-h-12 w-full items-center gap-3 rounded-xl border-2 border-kesari-600 px-3 text-left font-bold text-kesari-800 hover:bg-kesari-50 disabled:opacity-60"
        >
          <Icon name="locate-fixed" size={20} className="shrink-0" />
          {busy === "gps" ? tr(HOME.locating, lang) : tr(HOME.useCurrentLocation, lang)}
        </button>

        {savedAddresses.length > 0 ? (
          <div className="mt-4">
            <h3 className="mb-1.5 text-sm font-bold text-ink-700">{tr(HOME.savedAddresses, lang)}</h3>
            <ul className="space-y-1.5">
              {savedAddresses.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => choose({ addressId: a.id }, a.id)}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-cream-200 px-3 text-left text-sm text-ink-900 hover:bg-cream-100 disabled:opacity-60"
                  >
                    <Icon name="map-pin" size={18} className="shrink-0 text-kesari-700" />
                    <span className="min-w-0 truncate">{a.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void choose({ pincode: pincode.trim() }, "pin");
          }}
        >
          <label htmlFor="location-sheet-pin" className="mb-1.5 block text-sm font-bold text-ink-700">
            {tr(HOME.enterPincode, lang)}
          </label>
          <div className="flex gap-2">
            <input
              id="location-sheet-pin"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              required
              placeholder={tr(HOME.pincode, lang)}
              value={pincode}
              onChange={(e) => setPincode(e.target.value.replace(/\D/g, ""))}
              className="h-12 min-w-0 flex-1 rounded-xl border-2 border-cream-200 px-3 text-base tracking-widest focus:border-kesari-600 focus:outline-none"
            />
            <button type="submit" disabled={busy !== null} className="h-12 shrink-0 rounded-xl bg-kesari-700 px-4 font-bold text-white hover:bg-kesari-800 disabled:opacity-60">
              {tr(HOME.usePincode, lang)}
            </button>
          </div>
        </form>

        {error ? (
          <p role="alert" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
          {signedIn ? (
            <Link href="/profile/addresses" className="inline-flex min-h-11 items-center font-semibold text-kesari-700 hover:underline" onClick={onClose}>
              {tr(HOME.manageAddresses, lang)}
            </Link>
          ) : (
            <span />
          )}
          {currentLabel ? (
            <button type="button" disabled={busy !== null} onClick={() => choose(null, "clear")} className="min-h-11 font-semibold text-ink-600 hover:underline">
              {tr(HOME.clearLocation, lang)}
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
