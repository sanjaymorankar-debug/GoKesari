/**
 * D-23 (owner, 25 Oct 2026): after signing in again, go back to the page the
 * person was on, when that was within the last 24 hours.
 *
 * src/proxy.ts records every page navigation in a cookie (24 h); every
 * sign-in lands on /onboarding, which sends a complete profile there instead
 * of the home page. Only a same-site path is ever used.
 */
export const RETURN_TO_COOKIE = "gk_return_to";
export const RETURN_TO_MAX_AGE_S = 24 * 60 * 60;

/** Pages that are never a place to come back to. */
const NOT_A_RETURN_PATH = ["/signin", "/onboarding", "/api", "/_next", "/mobile-auth", "/r"];

/** The path (with its query) to come back to, or null when `raw` is not a safe same-site page. */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 512 || !raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, "https://return.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://return.invalid") return null;
  url.searchParams.delete("_rsc");
  const path = url.pathname;
  if (NOT_A_RETURN_PATH.some((p) => path === p || path.startsWith(`${p}/`))) return null;
  if (/\.[a-z0-9]+$/i.test(path)) return null; // a file, not a page
  return path + url.search;
}
