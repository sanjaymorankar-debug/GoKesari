"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { tr, UI, type Lang } from "@/lib/board/i18n";

import { Icon } from "./icons";

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/**
 * Offline state for every page (slow and patchy networks): a bar at the top
 * while the phone has no connection, and a short "Back online" when it
 * returns. Nothing on the page is cleared, so a half-filled form survives.
 */
export function OfflineBanner({ lang }: { lang: Lang }) {
  const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
  const [showBack, setShowBack] = useState(false);
  const [wasOffline, setWasOffline] = useState(false);

  // Render-time sync: remember an outage, and say so once when it ends.
  if (!online && !wasOffline) setWasOffline(true);
  if (online && wasOffline) {
    setWasOffline(false);
    setShowBack(true);
  }
  useEffect(() => {
    if (!showBack) return;
    const t = setTimeout(() => setShowBack(false), 3000);
    return () => clearTimeout(t);
  }, [showBack]);
  useEffect(() => {
    document.documentElement.toggleAttribute("data-offline", !online);
  }, [online]);

  if (online && !showBack) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      className={`fixed inset-x-0 bottom-0 z-50 flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold text-white ${online ? "bg-green-800" : "bg-ink-900"}`}
    >
      <Icon name={online ? "check" : "wifi-off"} size={18} />
      {online ? tr(UI.backOnline, lang) : tr(UI.offline, lang)}
    </div>
  );
}
