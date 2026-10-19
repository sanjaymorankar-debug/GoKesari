/**
 * Incoming links (F15.2.3): an App Link / Universal Link to the website, the
 * URL the app was opened with, or a tapped push notification's link. Only the
 * website's own pages are routed into the WebView; everything else is
 * ignored (the system already opened it elsewhere, or it is not ours).
 *
 * Plain TypeScript (no React Native imports) so it is unit-tested.
 */
import { originOf, parseUrl } from "./url";

/** Never opened in the app: API calls and downloads, the browser half of Google sign-in, association files. */
const EXCLUDED_PREFIXES = ["/api/", "/mobile-auth/", "/.well-known/"];

/**
 * The route map — what a shared link can point at. Every page of the site
 * opens in the app; these are the ones links are made for. Keep in step with
 * DEEP_LINK_ROUTES in src/lib/deep-links.ts (website) and the intent filters
 * in app.config.ts.
 */
export const DEEP_LINK_ROUTES = [
  { kind: "product", prefix: "/products/" },
  { kind: "shop", prefix: "/shops/" },
  { kind: "order", prefix: "/orders/" },
  { kind: "referral", prefix: "/r/" },
  { kind: "referral", prefix: "/refer" },
  { kind: "notification", prefix: "/notifications" },
  { kind: "ticket", prefix: "/support/tickets/" },
  // 1.3.0 (docs/homepage-uiux-2026-10): "Compare N prices" links.
  { kind: "compare", prefix: "/search/compare" },
] as const;

export type DeepLinkKind = (typeof DEEP_LINK_ROUTES)[number]["kind"] | "page";

/** A link to one of the website's pages, or null when it is not one the app should open. */
export function sitePageUrl(link: string | null | undefined, siteOrigin: string): string | null {
  if (!link) return null;
  const parsed = parseUrl(link);
  if (!parsed || (parsed.scheme !== "https" && parsed.scheme !== "http")) return null;
  if (originOf(parsed) !== siteOrigin) return null;
  if (EXCLUDED_PREFIXES.some((prefix) => parsed.path.startsWith(prefix))) return null;
  return link;
}

/** What a site link is about (for logs and tests); "page" for any other page of the site. */
export function deepLinkKind(link: string, siteOrigin: string): DeepLinkKind | null {
  const page = sitePageUrl(link, siteOrigin);
  if (!page) return null;
  const path = parseUrl(page)!.path;
  return DEEP_LINK_ROUTES.find((route) => path.startsWith(route.prefix))?.kind ?? "page";
}

/**
 * Where a tapped notification should go: its `url` (an in-site path such as
 * "/orders/123", or a full link to the site) inside the WebView. An outside
 * https link is returned as `outside` for the system browser; anything else
 * opens the Notification Centre.
 */
export function notificationTarget(
  data: unknown,
  siteOrigin: string,
): { action: "open"; url: string } | { action: "outside"; url: string } {
  const centre = `${siteOrigin}/notifications`;
  const raw = data && typeof data === "object" ? (data as { url?: unknown }).url : null;
  if (typeof raw !== "string" || raw.trim() === "") return { action: "open", url: centre };
  const value = raw.trim();
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) {
    return { action: "open", url: sitePageUrl(`${siteOrigin}${value}`, siteOrigin) ?? centre };
  }
  const page = sitePageUrl(value, siteOrigin);
  if (page) return { action: "open", url: page };
  const parsed = parseUrl(value);
  if (parsed?.scheme === "https" && parsed.host) return { action: "outside", url: value };
  return { action: "open", url: centre };
}
