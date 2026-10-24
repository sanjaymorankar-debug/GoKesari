/**
 * The shopper's position from the device, saved as the delivery location
 * discovery uses (owner request, 24 Oct 2026: "user location is not
 * detected"). Shared by the automatic detection on the shop and product pages
 * (components/auto-locate.tsx), the home page's "Find your location" button,
 * the "Use my current location" buttons and the Nearby screen.
 *
 * Works the same in a browser and in the GoKesari app, whose bridge answers
 * navigator.geolocation from the phone's location service. Saving goes
 * through POST /api/location: an httpOnly cookie on this device, nothing in
 * the database.
 *
 * Browser-only at run time, but every function takes the browser parts as an
 * argument so unit tests can hand in a fake.
 */

export type LocationProblem = "DENIED" | "UNAVAILABLE" | "TIMEOUT" | "INSECURE" | "UNSUPPORTED";

export interface DevicePosition {
  latitude: number;
  longitude: number;
  /** Metres, when the device says. */
  accuracyM: number | null;
}

export type FindResult = { ok: true; position: DevicePosition } | { ok: false; problem: LocationProblem };

export interface LocationEnv {
  geolocation: Pick<Geolocation, "getCurrentPosition"> | null;
  isSecureContext: boolean;
  permissions?: Pick<Permissions, "query"> | null;
}

/** First try: Wi-Fi / mobile network, or a fix from the last 5 minutes — quick, and enough to find shops. */
export const QUICK_FIX: PositionOptions = { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 };
/** Second try when the first finds nothing in time: GPS, with a longer wait. */
export const GPS_FIX: PositionOptions = { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 };

export function browserLocationEnv(): LocationEnv {
  if (typeof window === "undefined") return { geolocation: null, isSecureContext: false, permissions: null };
  // In the app the phone's own permission decides (its bridge asks for it); the WebView's answer would mislead.
  const inApp = Boolean((window as { __gokesariApp?: unknown }).__gokesariApp);
  return {
    geolocation: "geolocation" in navigator && navigator.geolocation ? navigator.geolocation : null,
    isSecureContext: window.isSecureContext,
    permissions: inApp ? null : (navigator.permissions ?? null),
  };
}

/** GeolocationPositionError codes: 1 refused, 2 unavailable, 3 timeout. */
export function problemFromCode(code: number | undefined): LocationProblem {
  if (code === 1) return "DENIED";
  if (code === 3) return "TIMEOUT";
  return "UNAVAILABLE";
}

function isUsable(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

function askOnce(geolocation: NonNullable<LocationEnv["geolocation"]>, options: PositionOptions): Promise<FindResult> {
  return new Promise((resolve) => {
    try {
      geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude, accuracy } = pos.coords;
          if (!isUsable(latitude, longitude)) return resolve({ ok: false, problem: "UNAVAILABLE" });
          resolve({
            ok: true,
            position: { latitude, longitude, accuracyM: Number.isFinite(accuracy) && accuracy > 0 ? Math.round(accuracy) : null },
          });
        },
        (error) => resolve({ ok: false, problem: problemFromCode(error?.code) }),
        options,
      );
    } catch {
      resolve({ ok: false, problem: "UNAVAILABLE" });
    }
  });
}

/**
 * Asks the device where it is. A quick network fix first; when that is
 * unavailable or too slow (a laptop without Wi-Fi, a phone indoors), once more
 * with GPS. A refusal is final — the person said no.
 */
export async function findDevicePosition(env: LocationEnv = browserLocationEnv()): Promise<FindResult> {
  if (!env.isSecureContext) return { ok: false, problem: "INSECURE" };
  if (!env.geolocation) return { ok: false, problem: "UNSUPPORTED" };
  const quick = await askOnce(env.geolocation, QUICK_FIX);
  if (quick.ok || quick.problem === "DENIED") return quick;
  return askOnce(env.geolocation, GPS_FIX);
}

/** Whether this site may already read the location ("unknown" where the browser cannot say). */
export async function locationPermission(env: LocationEnv = browserLocationEnv()): Promise<PermissionState | "unknown"> {
  try {
    const status = await env.permissions?.query({ name: "geolocation" });
    return status?.state ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface SavedLocation {
  /** False when `ifUnset` was asked and a location was already chosen. */
  saved: boolean;
  label: string;
}

/**
 * Saves the position as the delivery location. With `ifUnset` the server
 * keeps a location the person already chose (or their saved address) — for
 * the automatic detection, which must never overwrite a choice made while
 * the device was still answering.
 */
export async function saveDevicePosition(
  position: Pick<DevicePosition, "latitude" | "longitude">,
  options: { ifUnset?: boolean } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<SavedLocation> {
  const response = await fetchImpl("/api/location", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      latitude: position.latitude,
      longitude: position.longitude,
      ...(options.ifUnset ? { ifUnset: true } : {}),
    }),
  });
  const payload = (await response.json().catch(() => null)) as { label?: string; saved?: boolean; error?: { message?: string } } | null;
  if (!response.ok) throw new Error(payload?.error?.message ?? "That location could not be used.");
  return { saved: payload?.saved !== false, label: payload?.label ?? "Current location" };
}

/**
 * The pages where shops and products are listed for the delivery location —
 * where finding it by itself is worth a permission prompt. The Nearby screen
 * asks on its own, so it is left out.
 */
export function isDiscoveryPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (pathname === "/" || pathname === "/shops" || pathname === "/search") return true;
  if (pathname === "/shops/nearby" || pathname.startsWith("/shops/nearby/")) return false;
  return pathname.startsWith("/shops/") || pathname.startsWith("/search/") || pathname.startsWith("/category/");
}
