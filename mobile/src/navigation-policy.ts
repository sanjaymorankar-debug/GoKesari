/**
 * Where a link or navigation inside the WebView should go.
 *
 * The website is the app, so its own pages always load in place. Payment
 * pages must also stay inside: Cashfree's checkout and the bank's 3-D Secure
 * page run in an iframe on the checkout page, and Android's WebView reports
 * every navigation as top-frame (react-native-webview always sends
 * isTopFrame: true there), so "unknown site → browser" would throw a card
 * payment out of the app half-way through. Unknown sites therefore load in
 * place; links the user taps to other sites are sent to the browser by the
 * page bridge (bridge-script.ts) instead, which can tell a tap from a payment
 * redirect.
 */
import { originOf, parseUrl, type ParsedUrl } from "./url";

export type NavigationDecision =
  /** Let the WebView load it. */
  | { action: "load" }
  /** Drop it. */
  | { action: "block" }
  /** Google refuses sign-in inside an app's WebView: hand it to the system browser (google-sign-in.ts). */
  | { action: "google-sign-in" }
  /** Another app or the browser: maps, WhatsApp, the dialler, UPI apps… */
  | { action: "open-outside"; url: string; fallbackUrl?: string; storePackage?: string };

/** Never followed: local files, and the app's own sign-in callback (only the system browser sends it). */
const BLOCKED_SCHEMES = new Set(["file", "content", "gokesari", "gokesari-preview"]);
/** Handled by the WebView itself. */
const WEBVIEW_SCHEMES = new Set(["about", "data", "blob", "javascript"]);

const GOOGLE_SIGN_IN_HOSTS = new Set(["accounts.google.com"]);

function isGoogleMaps(url: ParsedUrl): boolean {
  const host = url.host.replace(/^www\./, "");
  if (host === "maps.google.com" || host === "maps.app.goo.gl" || host === "maps.apple.com") return true;
  if (/^google\.[a-z.]+$/.test(host) || host === "goo.gl") return url.path.startsWith("/maps");
  return false;
}

/** Sites that are better in their own app: navigation, chat, the app stores. */
function belongsInOwnApp(url: ParsedUrl): boolean {
  return (
    isGoogleMaps(url) ||
    ["wa.me", "api.whatsapp.com", "chat.whatsapp.com", "play.google.com", "apps.apple.com", "itunes.apple.com"].includes(
      url.host,
    )
  );
}

export function decideNavigation(rawUrl: string, siteOrigin: string, isTopFrame: boolean): NavigationDecision {
  const url = parseUrl(rawUrl);
  if (!url) return { action: "block" };

  if (WEBVIEW_SCHEMES.has(url.scheme)) return { action: "load" };
  if (BLOCKED_SCHEMES.has(url.scheme)) return { action: "block" };

  if (url.scheme === "http" || url.scheme === "https") {
    if (originOf(url) === siteOrigin) return { action: "load" };
    if (!isTopFrame) return { action: "load" };
    if (GOOGLE_SIGN_IN_HOSTS.has(url.host)) return { action: "google-sign-in" };
    if (belongsInOwnApp(url)) return { action: "open-outside", url: rawUrl };
    return { action: "load" };
  }

  if (url.scheme === "intent") {
    const intent = parseAndroidIntentUrl(rawUrl);
    if (!intent?.url) {
      // Nothing to open directly: use the page's own fallback, else the app's store listing.
      if (intent?.fallbackUrl) return { action: "open-outside", url: intent.fallbackUrl };
      if (intent?.packageName) return { action: "open-outside", url: playStoreUrl(intent.packageName) };
      return { action: "block" };
    }
    return {
      action: "open-outside",
      url: intent.url,
      ...(intent.fallbackUrl ? { fallbackUrl: intent.fallbackUrl } : {}),
      ...(intent.packageName ? { storePackage: intent.packageName } : {}),
    };
  }

  // tel:, mailto:, sms:, upi:, whatsapp:, geo:, market:, UPI app schemes (tez:, phonepe:, paytmmp:…)
  return { action: "open-outside", url: rawUrl };
}

/**
 * Chrome-style `intent://…#Intent;scheme=upi;package=…;end` links, which
 * payment pages use to open a specific UPI app. They cannot be opened as-is
 * from outside Chrome, so the data URL is rebuilt (`upi://…`) and Android
 * offers the apps that handle it.
 */
export function parseAndroidIntentUrl(
  raw: string,
): { url: string | null; packageName?: string; fallbackUrl?: string } | null {
  const match = /^intent:(?:\/\/)?([^#]*)#Intent;(.*)$/i.exec(raw.trim());
  if (!match) return null;
  const [, target, extras] = match;
  const fields = new Map<string, string>();
  for (const part of extras.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
  }

  const scheme = fields.get("scheme");
  const packageName = fields.get("package");
  let fallbackUrl = fields.get("S.browser_fallback_url");
  if (fallbackUrl) {
    try {
      fallbackUrl = decodeURIComponent(fallbackUrl);
    } catch {
      fallbackUrl = undefined;
    }
  }
  const fallback = fallbackUrl ? parseUrl(fallbackUrl) : null;

  return {
    url: scheme && /^[a-z][a-z0-9+.-]*$/i.test(scheme) ? `${scheme}://${target}` : null,
    ...(packageName && /^[A-Za-z0-9_.]+$/.test(packageName) ? { packageName } : {}),
    ...(fallback && (fallback.scheme === "https" || fallback.scheme === "http") ? { fallbackUrl } : {}),
  };
}

export function playStoreUrl(packageName: string): string {
  return `market://details?id=${encodeURIComponent(packageName)}`;
}

/** For links that open a new window (target="_blank", window.open): only the site's own pages stay in the app. */
export function decideNewWindow(rawUrl: string, siteOrigin: string): NavigationDecision {
  const decision = decideNavigation(rawUrl, siteOrigin, true);
  if (decision.action !== "load") return decision;
  const url = parseUrl(rawUrl);
  if (url && originOf(url) === siteOrigin) return decision;
  if (url && (url.scheme === "http" || url.scheme === "https")) return { action: "open-outside", url: rawUrl };
  return { action: "block" };
}
