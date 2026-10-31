"use client";

import { useEffect, useState } from "react";

import { isMobileAppUserAgent } from "@/lib/mobile-app";
import { LANG_TAG, tr, UI, type Lang } from "@/lib/board/i18n";

import { Icon } from "../board/icons";

/** How often an open app checks for a new version while it stays open (on top of every launch). */
const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;

/**
 * docs/app-install-2026-10: registers the service worker (src/app/sw.js/route.ts)
 * and offers "Reload" when a new version is ready. Not pressing it is fine: the
 * new version takes over the next time the app is opened. The native app
 * (mobile/) has its own update check, so the worker is not registered there.
 */
export function AppUpdatePrompt({ lang }: { lang: Lang }) {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || isMobileAppUserAgent(navigator.userAgent)) return;
    let registration: ServiceWorkerRegistration | null = null;
    let reloading = false;
    // Only a worker replacing an older one is an update; the very first install is not.
    const hadController = Boolean(navigator.serviceWorker.controller);

    const watch = (reg: ServiceWorkerRegistration) => {
      if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const next = reg.installing;
        next?.addEventListener("statechange", () => {
          if (next.state === "installed" && navigator.serviceWorker.controller) setWaiting(next);
        });
      });
    };
    const onControllerChange = () => {
      if (!hadController || reloading) return;
      reloading = true;
      window.location.reload();
    };
    const check = () => {
      if (document.visibilityState === "visible") void registration?.update().catch(() => {});
    };

    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        registration = reg;
        watch(reg);
      })
      .catch(() => {});
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    document.addEventListener("visibilitychange", check);
    const timer = window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", check);
      window.clearInterval(timer);
    };
  }, []);

  if (!waiting) return null;
  return (
    <div
      lang={LANG_TAG[lang]}
      role="status"
      aria-live="polite"
      data-testid="app-update-prompt"
      className="fixed inset-x-3 top-3 z-50 mx-auto flex max-w-xl items-center gap-3 rounded-2xl border border-cream-200 border-l-4 border-l-kesari-600 bg-white p-3 shadow-xl shadow-ink-900/15"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kesari-100 text-kesari-700">
        <Icon name="refresh-cw" size={20} />
      </span>
      <p className="min-w-0 flex-1 text-sm font-semibold text-ink-900">{tr(UI.updateReady, lang)}</p>
      <button
        type="button"
        data-testid="app-update-reload"
        onClick={() => waiting.postMessage({ type: "SKIP_WAITING" })}
        className="flex h-11 shrink-0 items-center rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white hover:bg-kesari-800"
      >
        {tr(UI.updateReload, lang)}
      </button>
    </div>
  );
}
