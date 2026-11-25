/**
 * 1.15.0 — deferred referral link (docs/referral-sharing-2026-11). A referral link opened in the phone's
 * browser before the app was installed leaves its code in the browser's cookies, which the app's
 * WebView cannot see. On the app's very first open (no link), the first page is /app-open: the website
 * matches that phone's recent link click and pre-fills the code in the app, then shows the usual page.
 * A marker file in the app's documents folder makes it once per install.
 */
import { File, Paths } from "expo-file-system";

const MARKER = "first-open-v1.done";

/** The first page: the link the app was opened with, else /app-open on the first open, else the home page. */
export function firstPageFor(link: string | null, firstOpen: boolean, siteUrl: string, siteOrigin: string): string {
  if (link) return link;
  return firstOpen ? `${siteOrigin}/app-open` : siteUrl;
}

/** True once per install: the marker is written on the first call. Never throws (a failure counts as not first). */
export function takeFirstOpen(): boolean {
  try {
    const marker = new File(Paths.document, MARKER);
    if (marker.exists) return false;
    marker.create();
    return true;
  } catch {
    return false;
  }
}
