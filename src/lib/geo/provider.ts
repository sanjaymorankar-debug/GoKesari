/**
 * Client-side loader for the Google Maps JavaScript SDK (delivery-system
 * Part 58 follow-up). Loads Maps JS + Places (Autocomplete) only — this is
 * the browser-restricted, publishable-key half of the architecture.
 * Reverse-geocoding to persist a confirmed location happens server-side (see
 * src/server/services/geocoding.ts) and is logged there; nothing loaded by
 * this file ever calls the server or gets logged, since Autocomplete/map
 * display billing is per-session/per-load on Google's side, not something
 * this app can or should log itself.
 */

declare global {
  interface Window {
    google?: typeof google;
    __gokesariMapsCallback?: () => void;
    /** Google calls this when it refuses the key (e.g. RefererNotAllowedMapError). */
    gm_authFailure?: () => void;
  }
}

/** The browser-restricted key. Empty string when unset — callers must check `isMapsAvailable()` first. */
export const GOOGLE_MAPS_BROWSER_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";

export function isMapsAvailable(): boolean {
  return GOOGLE_MAPS_BROWSER_KEY.length > 0;
}

let loadPromise: Promise<void> | null = null;

/**
 * Google loads the script even when it refuses the key (wrong website restriction, billing off,
 * API not enabled) and only says so through window.gm_authFailure — the map then stays grey.
 * Seen on test.gokesari.com, 30 Oct 2026: RefererNotAllowedMapError. Listeners hear it once.
 */
let authFailed = false;
const authListeners = new Set<() => void>();

export function onMapsAuthFailure(listener: () => void): () => void {
  if (authFailed) {
    listener();
    return () => {};
  }
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

/** Loads the Maps JS + Places libraries at most once per page. */
export function loadGoogleMaps(): Promise<void> {
  if (!isMapsAvailable()) {
    return Promise.reject(new Error("Google Maps is not configured."));
  }
  if (window.google?.maps) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    window.gm_authFailure = () => {
      authFailed = true;
      console.error("Google Maps refused the browser key for this site — check the key's website restrictions.");
      authListeners.forEach((listener) => listener());
      authListeners.clear();
    };
    window.__gokesariMapsCallback = () => resolve();
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_BROWSER_KEY}&libraries=places&callback=__gokesariMapsCallback`;
    script.async = true;
    script.onerror = () => reject(new Error("Failed to load Google Maps."));
    document.head.appendChild(script);
  });
  return loadPromise;
}

/** Wraps the browser's native geolocation — free, not a Google Maps Platform call. */
export function getCurrentPosition(): Promise<{ latitude: number; longitude: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location is not available on this device."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      (err) => reject(new Error(err.message || "Could not get your location.")),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  });
}
