/**
 * Deep links into the GoKesari app (F15.2.3, NEW-044): Android App Links and
 * iOS Universal Links for gokesari.com (store build com.gokesari.app) and
 * test.gokesari.com (preview build com.gokesari.app.preview).
 *
 * The association files are served always — host-aware — with the signing
 * details from the environment, or a literal placeholder until the owner sets
 * them (docs/deep-links-activation.md). A placeholder is harmless: Android's
 * and Apple's verification simply fails, so links keep opening in the
 * browser, exactly as when the files did not exist.
 */
import { getEnv } from "./env";
import { androidAssetLinks, appleAppSiteAssociation } from "./mobile-app";

export const ANDROID_FINGERPRINT_PLACEHOLDER = "REPLACE_WITH_SHA256_SIGNING_FINGERPRINT";
export const APPLE_TEAM_ID_PLACEHOLDER = "REPLACE_WITH_APPLE_TEAM_ID";

/** The two app builds and the site each one shows (mobile/app.config.ts VARIANTS). */
export const APP_BUILDS = {
  production: { host: "gokesari.com", appId: "com.gokesari.app" },
  preview: { host: "test.gokesari.com", appId: "com.gokesari.app.preview" },
} as const;
export type AppBuild = keyof typeof APP_BUILDS;

/**
 * Where a shared link points, by what it is about. Every prefix opens in the
 * app (Android intent filters in mobile/app.config.ts; iOS through the
 * association's catch-all component) and is routed into its WebView.
 */
export const DEEP_LINK_ROUTES = [
  { kind: "product", example: "/products/<id>", prefix: "/products/" },
  { kind: "shop", example: "/shops/<slug>", prefix: "/shops/" },
  { kind: "order", example: "/orders/<id>", prefix: "/orders/" },
  { kind: "referral", example: "/r/<code>", prefix: "/r/" },
  { kind: "referral", example: "/refer", prefix: "/refer" },
  { kind: "notification", example: "/notifications/<id>", prefix: "/notifications" },
  // WS-C's help desk (/support): ticket pages.
  { kind: "ticket", example: "/support/tickets/<id>", prefix: "/support/tickets/" },
  // docs/homepage-uiux-2026-10 (F4): a product's price comparison ("Compare N prices").
  { kind: "compare", example: "/search/compare?product=<id>", prefix: "/search/compare" },
] as const;

/** test.gokesari.com (and any test.* host) is the preview build; everything else the store build. */
export function appBuildForHost(host: string | null | undefined): AppBuild {
  const name = (host ?? "").toLowerCase().split(":")[0].replace(/\.$/, "");
  return name === APP_BUILDS.preview.host || name.startsWith("test.") ? "preview" : "production";
}

/** The host a request was made to (behind Hostinger's proxy: x-forwarded-host), else the site's AUTH_URL host. */
export function requestHost(request?: Request | null): string {
  const forwarded = request?.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwarded || request?.headers.get("host")?.trim();
  if (host) return host;
  try {
    const authUrl = getEnv().AUTH_URL;
    return authUrl ? new URL(authUrl).host : APP_BUILDS.production.host;
  } catch {
    return APP_BUILDS.production.host;
  }
}

/** Read at request time (not the cached getEnv()) so a value set on the host applies on the next request. */
function list(name: "MOBILE_ANDROID_CERT_SHA256" | "MOBILE_IOS_APP_IDS"): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** The Android package for this host: MOBILE_ANDROID_PACKAGE when set, else the host's build. */
export function androidPackageFor(host: string): string {
  return process.env.MOBILE_ANDROID_PACKAGE?.trim() || APP_BUILDS[appBuildForHost(host)].appId;
}

/** /.well-known/assetlinks.json for this host; the fingerprint placeholder until MOBILE_ANDROID_CERT_SHA256 is set. */
export function assetLinksFor(host: string) {
  const fingerprints = list("MOBILE_ANDROID_CERT_SHA256").map((f) => f.toUpperCase());
  return {
    placeholder: fingerprints.length === 0,
    body: androidAssetLinks(androidPackageFor(host), fingerprints.length ? fingerprints : [ANDROID_FINGERPRINT_PLACEHOLDER]),
  };
}

/** /.well-known/apple-app-site-association for this host; the Team ID placeholder until MOBILE_IOS_APP_IDS is set. */
export function appleAssociationFor(host: string) {
  const appIds = list("MOBILE_IOS_APP_IDS");
  return {
    placeholder: appIds.length === 0,
    body: appleAppSiteAssociation(
      appIds.length ? appIds : [`${APPLE_TEAM_ID_PLACEHOLDER}.${APP_BUILDS[appBuildForHost(host)].appId}`],
    ),
  };
}
