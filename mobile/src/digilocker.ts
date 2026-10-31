/**
 * 1.6.0: delivery partners share their Aadhaar from DigiLocker (website:
 * src/server/services/rider-kyc.ts). The KYC page asks the app, through the
 * bridge (`__gokesariApp.openDigiLocker(url)`), to open DigiLocker in the
 * system's in-app browser — ASWebAuthenticationSession on iOS, a Custom Tab on
 * Android — like Google sign-in: DigiLocker is a government OAuth page, which
 * belongs in a real browser rather than inside the app's WebView. When the
 * partner finishes (or declines), the website's return link hands back to
 * `<scheme>://digilocker-return`, the browser closes, and the page re-checks
 * the result. The Sandbox DigiLocker SDK is not used: it needs its own SDK
 * sessions and a native module, and the website already runs the session.
 *
 * Plain TypeScript (no React Native imports) so it is unit-tested.
 */
import { originOf, parseUrl, queryParam } from "./url";

/** DigiLocker's own hosts (the authorization page Sandbox links to). */
const DIGILOCKER_HOSTS = ["digilocker.meripehchaan.gov.in", "digilocker.gov.in"];

/** The website's mock consent page (test site and local work only; the website refuses it on gokesari.com). */
const MOCK_PATH = "/mobile-auth/digilocker-mock";

export const DIGILOCKER_CALLBACK_HOST = "digilocker-return";

/** Only DigiLocker itself, or the site's own mock page, may be opened this way. */
export function isDigilockerUrl(raw: unknown, siteOrigin: string): raw is string {
  if (typeof raw !== "string") return false;
  const url = parseUrl(raw);
  if (!url) return false;
  if (url.scheme === "https" && DIGILOCKER_HOSTS.some((host) => url.host === host || url.host.endsWith(`.${host}`))) return true;
  return originOf(url) === siteOrigin && url.path === MOCK_PATH;
}

export function digilockerCallbackUrl(scheme: string): string {
  return `${scheme}://${DIGILOCKER_CALLBACK_HOST}`;
}

export type DigilockerResult = "verified" | "pending" | "failed" | "unknown" | "cancelled";

/** What the return link said (`?result=`), or "cancelled" when the partner closed the browser. */
export function digilockerResult(callback: string | null): DigilockerResult {
  if (!callback) return "cancelled";
  const url = parseUrl(callback);
  const result = url ? queryParam(url.query, "result") : null;
  return result === "verified" || result === "pending" || result === "failed" ? result : "unknown";
}
