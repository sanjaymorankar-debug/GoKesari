"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import {
  canApplyUpdate,
  FOCUS_CHECK_MIN_MS,
  IDLE_APPLY_MS,
  LAST_USER_KEY,
  mustClearUserData,
  recoverFromChunkError,
  UPDATE_CHECK_INTERVAL_MS,
  USER_SCOPED_STORAGE_KEYS,
} from "@/lib/app-update-policy";
import { isMobileAppUserAgent } from "@/lib/mobile-app";

/**
 * docs/silent-update-2026-11 (replaces the "A new version of GoKesari is
 * ready — Reload" bar): registers the service worker (src/app/sw.js/route.ts)
 * and keeps the site on the newest version without ever asking anyone.
 *
 *  - A new version installs in the background and takes over at once
 *    (skipWaiting + clients.claim). The page itself switches at a safe
 *    moment: the next page change, the tab being hidden, or five idle
 *    minutes — never on a payment, checkout, registration or billing page,
 *    with a form being filled, a file picked or a payment window open
 *    (rules: src/lib/app-update-policy.ts).
 *  - Checks: on start, when the tab comes back to view, and every 30 minutes.
 *  - A lazy-loaded file removed by a deploy: one silent reload, never a loop.
 *  - Sign-out or a different account: the previous person's browser-kept
 *    data (recent searches, guest favourites) is cleared.
 *
 * Renders nothing. The native app (mobile/) loads the live site without the
 * worker and has its own check, so the worker is not registered there.
 */
export function AppAutoUpdate({ userKey }: { userKey: string | null }) {
  const pathname = usePathname();
  const pending = useRef(false);
  const dirty = useRef(false);
  const pathRef = useRef(pathname);
  const firstPath = useRef(true);
  const applyRef = useRef<(() => void) | null>(null);

  // One account's browser-kept data never shows for the next one.
  useEffect(() => {
    const current = userKey ?? "guest";
    try {
      const previous = window.localStorage.getItem(LAST_USER_KEY);
      if (mustClearUserData(previous, current)) for (const key of USER_SCOPED_STORAGE_KEYS) window.localStorage.removeItem(key);
      if (previous !== current) window.localStorage.setItem(LAST_USER_KEY, current);
    } catch {
      // Storage blocked: nothing kept, nothing to clear.
    }
  }, [userKey]);

  // Stale lazy-loaded chunks after a deploy: one silent reload.
  useEffect(() => {
    const onError = (event: ErrorEvent) => void recoverFromChunkError(event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent) => void recoverFromChunkError(event.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || isMobileAppUserAgent(navigator.userAgent)) return;
    let registration: ServiceWorkerRegistration | null = null;
    let lastCheck = 0;
    let idleTimer = 0;
    let reloading = false;
    // Only a worker replacing an older one is an update; the very first install is not.
    const hadController = Boolean(navigator.serviceWorker.controller);

    const safe = () =>
      canApplyUpdate({
        pathname: pathRef.current,
        dirty: dirty.current,
        paymentOpen: Boolean(document.querySelector('iframe[src*="cashfree"]')),
      });
    const apply = () => {
      if (!pending.current || reloading || !safe()) return;
      reloading = true;
      window.location.reload();
    };
    // A worker installed by an older script waits for a message; newer ones skip waiting on their own.
    const activate = (worker: ServiceWorker | null) => {
      if (worker && navigator.serviceWorker.controller) worker.postMessage({ type: "SKIP_WAITING" });
    };
    const watch = (reg: ServiceWorkerRegistration) => {
      activate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const next = reg.installing;
        next?.addEventListener("statechange", () => {
          if (next.state === "installed") activate(next);
        });
      });
    };
    const check = (force = false) => {
      if (document.visibilityState !== "visible" || !registration) return;
      if (!force && Date.now() - lastCheck < FOCUS_CHECK_MIN_MS) return;
      lastCheck = Date.now();
      void registration.update().catch(() => {});
    };
    const onControllerChange = () => {
      if (!hadController) return;
      pending.current = true;
      if (document.visibilityState === "hidden") apply();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") apply();
      else check();
    };
    const resetIdle = () => {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        if (document.visibilityState === "visible") apply();
        resetIdle();
      }, IDLE_APPLY_MS);
    };
    const markDirty = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) dirty.current = true;
      else if (target?.isContentEditable) dirty.current = true;
    };

    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        registration = reg;
        lastCheck = Date.now(); // register() itself checked.
        watch(reg);
      })
      .catch(() => {});
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("input", markDirty, true);
    document.addEventListener("change", markDirty, true);
    const activity = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    for (const name of activity) window.addEventListener(name, resetIdle, { passive: true, capture: true });
    resetIdle();
    const timer = window.setInterval(() => check(true), UPDATE_CHECK_INTERVAL_MS);
    applyRef.current = apply;
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("input", markDirty, true);
      document.removeEventListener("change", markDirty, true);
      for (const name of activity) window.removeEventListener(name, resetIdle, { capture: true });
      window.clearTimeout(idleTimer);
      window.clearInterval(timer);
      applyRef.current = null;
    };
  }, []);

  // The next page change is a safe moment: the new page loads on the new version.
  useEffect(() => {
    pathRef.current = pathname;
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    dirty.current = false; // A new page: nothing typed on it yet.
    applyRef.current?.();
  }, [pathname]);

  return null;
}
