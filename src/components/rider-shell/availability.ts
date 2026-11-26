/**
 * The rider's Offline / Active / Ready switch, shared by the dashboard's
 * availability card and the Rider App v2 header's Online/Offline toggle.
 *
 * Going Active or Ready needs a location fix (the browser's own geolocation —
 * never a maps API call); the change is a PATCH to /api/delivery-partner/status.
 * Browser-only: call it from client components.
 */
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";

export type RiderAvailability = "OFFLINE" | "ACTIVE" | "READY";

const T = {
  errNoServer: L(
    "Could not reach the server. Check your connection and try again.",
    "सर्वर से संपर्क नहीं हो सका। इंटरनेट देखें और फिर कोशिश करें।",
    "सर्व्हरशी संपर्क झाला नाही. इंटरनेट तपासा आणि पुन्हा प्रयत्न करा.",
  ),
  errOffline: L("Could not go offline. Try again.", "ऑफ़लाइन नहीं हो सके। फिर कोशिश करें।", "ऑफलाइन होता आले नाही. पुन्हा प्रयत्न करा."),
  errNoGeo: L(
    "Your browser does not support location — cannot go online.",
    "आपका ब्राउज़र लोकेशन सपोर्ट नहीं करता — ऑनलाइन नहीं हो सकते।",
    "तुमचा ब्राउझर लोकेशनला सपोर्ट करत नाही — ऑनलाइन होता येणार नाही.",
  ),
  errNoFix: L("Could not get your location. Try again.", "आपकी लोकेशन नहीं मिली। फिर कोशिश करें।", "तुमचे लोकेशन मिळाले नाही. पुन्हा प्रयत्न करा."),
  errActive: L("Could not switch to Active.", "सक्रिय नहीं हो सके।", "सक्रिय होता आले नाही."),
  errReady: L("Could not switch to Ready.", "तैयार पर नहीं जा सके।", "तयार वर जाता आले नाही."),
  errPermission: L(
    "Location permission is required to go online.",
    "ऑनलाइन होने के लिए लोकेशन की अनुमति ज़रूरी है।",
    "ऑनलाइन होण्यासाठी लोकेशनची परवानगी आवश्यक आहे.",
  ),
} as const;

const REQUEST_TIMEOUT_MS = 10_000;
const LOCATION_TIMEOUT_MS = 20_000;
// Outlasts the geolocation timeout, for browsers that never call either callback (Firefox "Not now").
const GO_ONLINE_WATCHDOG_MS = LOCATION_TIMEOUT_MS + 10_000;

export interface AvailabilityResult {
  ok: boolean;
  /** Shown to the rider when the change did not go through. */
  error?: string;
  /** Re-read the page: the change may have committed although the reply was lost. */
  refresh?: boolean;
}

async function patchStatus(body: Record<string, string | number>, fallback: Text, lang: Lang): Promise<AvailabilityResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch("/api/delivery-partner/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.ok) return { ok: true };
    const payload = await response.json().catch(() => null);
    return { ok: false, error: errorText(payload?.error?.message ?? tr(fallback, lang), lang, payload?.error?.code) };
  } catch {
    return { ok: false, error: tr(T.errNoServer, lang), refresh: true };
  } finally {
    clearTimeout(timeout);
  }
}

/** Switch to `target`. Resolves once the server answered (or the location request failed). */
export function requestAvailability(target: RiderAvailability, lang: Lang): Promise<AvailabilityResult> {
  if (target === "OFFLINE") return patchStatus({ action: "offline" }, T.errOffline, lang);
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
    return Promise.resolve({ ok: false, error: tr(T.errNoGeo, lang) });
  }
  return new Promise((resolve) => {
    // A late callback after the watchdog fired must not submit the PATCH behind the rider's back.
    let settled = false;
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: tr(T.errNoFix, lang) });
    }, GO_ONLINE_WATCHDOG_MS);
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(watchdog);
      return true;
    };
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          if (!settle()) return;
          void patchStatus(
            { action: target === "ACTIVE" ? "active" : "ready", latitude: position.coords.latitude, longitude: position.coords.longitude },
            target === "ACTIVE" ? T.errActive : T.errReady,
            lang,
          ).then(resolve);
        },
        (err) => {
          if (!settle()) return;
          resolve({ ok: false, error: err.code === err.PERMISSION_DENIED ? tr(T.errPermission, lang) : tr(T.errNoFix, lang) });
        },
        // A position up to a minute old is still live (the zone allows 15 minutes). While Active or
        // Ready the heartbeat's watchPosition is running, and a request for a brand-new fix next to
        // it can wait until it times out (seen on test.gokesari.com): Active → Ready never went through.
        { timeout: LOCATION_TIMEOUT_MS, maximumAge: 60_000 },
      );
    } catch {
      if (!settle()) return;
      resolve({ ok: false, error: tr(T.errNoFix, lang) });
    }
  });
}
