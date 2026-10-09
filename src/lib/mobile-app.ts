/**
 * The GoKesari Android/iOS app (mobile/ in this repository).
 *
 * The app is a native shell around this website: every page is the same page
 * a browser gets. These constants are the contract between the two sides —
 * change them here and in mobile/src/config.ts together.
 */

/** Appended to the app's WebView user agent, e.g. "GoKesariApp/1.0.0 (android)". */
export const MOBILE_APP_UA_TOKEN = "GoKesariApp";

/**
 * URL schemes of the app builds: the store build and the preview build that
 * points at test.gokesari.com. A sign-in code is only ever handed back to one
 * of these, never to a scheme taken from the request.
 */
export const MOBILE_APP_SCHEMES = ["gokesari", "gokesari-preview"] as const;
export type MobileAppScheme = (typeof MOBILE_APP_SCHEMES)[number];

/** `<scheme>://auth-callback?code=…` — where the browser hands the sign-in code back to the app. */
export const MOBILE_AUTH_CALLBACK_HOST = "auth-callback";

/** True when the request comes from the app's WebView rather than a browser. */
export function isMobileAppUserAgent(userAgent: string | null | undefined): boolean {
  return Boolean(userAgent && new RegExp(`\\b${MOBILE_APP_UA_TOKEN}/`).test(userAgent));
}

export function isMobileAppScheme(value: string | null | undefined): value is MobileAppScheme {
  return (MOBILE_APP_SCHEMES as readonly string[]).includes(value ?? "");
}

export function mobileAuthCallbackUrl(scheme: MobileAppScheme, code: string): string {
  return `${scheme}://${MOBILE_AUTH_CALLBACK_HOST}?code=${encodeURIComponent(code)}`;
}

/**
 * Paths a link must never hand to the app: API calls (file downloads, the
 * emailed sign-in link), the browser half of the app's own Google sign-in, and
 * these association files. Everything else is a page the app shows.
 */
export const MOBILE_APP_LINK_EXCLUDED_PATHS = ["/api/*", "/mobile-auth/*", "/.well-known/*"] as const;

/** /.well-known/assetlinks.json — Android App Links. */
export function androidAssetLinks(androidPackage: string, certFingerprints: readonly string[]) {
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: androidPackage,
        sha256_cert_fingerprints: [...certFingerprints],
      },
    },
  ];
}

/** /.well-known/apple-app-site-association — iOS Universal Links. */
export function appleAppSiteAssociation(appIds: readonly string[]) {
  return {
    applinks: {
      details: [
        {
          appIDs: [...appIds],
          components: [
            ...MOBILE_APP_LINK_EXCLUDED_PATHS.map((path) => ({ "/": path, exclude: true })),
            { "/": "*" },
          ],
        },
      ],
    },
  };
}
