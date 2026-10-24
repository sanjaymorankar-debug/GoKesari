"use client";

/**
 * "Find your location" on the home page's "Set your location" line (owner
 * request, 24 Oct 2026): one tap asks the device for its position, saves it
 * as the delivery location and refreshes the page, so shops near you,
 * banners and "Popular in your area" follow. When the device cannot say
 * where it is, the reason in words and a button to the PIN code box.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Icon } from "@/components/board/icons";
import { OPEN_LOCATION_EVENT } from "@/components/location-picker";
import { tr, type Lang } from "@/lib/board/i18n";
import { findDevicePosition, saveDevicePosition } from "@/lib/device-location";
import { HOME, LOCATION_PROBLEM_TEXT } from "@/lib/home-i18n";

export function FindLocationButton({ lang }: { lang: Lang }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function find() {
    setBusy(true);
    setError(null);
    try {
      const found = await findDevicePosition();
      if (!found.ok) {
        setError(tr(LOCATION_PROBLEM_TEXT[found.problem], lang));
        return;
      }
      await saveDevicePosition(found.position);
      router.refresh();
    } catch {
      setError(tr(HOME.locationFailed, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void find()}
        disabled={busy}
        data-testid="find-location"
        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-kesari-700 px-3 text-sm font-bold text-white hover:bg-kesari-800 disabled:opacity-60"
      >
        <Icon name="locate-fixed" size={16} className={busy ? "animate-pulse" : undefined} />
        {busy ? tr(HOME.locating, lang) : tr(HOME.findYourLocation, lang)}
      </button>
      {error ? (
        <span role="alert" className="flex w-full flex-wrap items-center gap-2 text-amber-900" data-testid="find-location-error">
          {error}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event(OPEN_LOCATION_EVENT))}
            className="min-h-11 font-semibold text-kesari-700 underline"
          >
            {tr(HOME.enterPincodeInstead, lang)}
          </button>
        </span>
      ) : null}
    </>
  );
}
