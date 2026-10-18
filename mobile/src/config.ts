import Constants from "expo-constants";

/**
 * Per-build settings, from app.config.ts (`extra`). The store build points at
 * gokesari.com; the preview build (APP_VARIANT=preview) at test.gokesari.com.
 */
interface Extra {
  siteUrl: string;
  scheme: string;
  appVariant: "production" | "preview";
}

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Extra>;

/** The website the app shows, without a trailing slash. */
export const SITE_URL = (extra.siteUrl ?? "https://gokesari.com").replace(/\/+$/, "");

/** This build's URL scheme; the website hands Google sign-in back to `<scheme>://auth-callback`. */
export const APP_SCHEME = extra.scheme ?? "gokesari";

/**
 * Appended to the WebView's user agent so the website knows it is inside the
 * app. Must match MOBILE_APP_UA_TOKEN in src/lib/mobile-app.ts (the website).
 */
export const UA_TOKEN = "GoKesariApp";

export const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";

/** Which build this is (production: gokesari.com, preview: test.gokesari.com) — sent with the push token. */
export const APP_VARIANT: "production" | "preview" = extra.appVariant === "preview" ? "preview" : "production";

/** Colours from the website's theme (src/app/globals.css). */
export const COLORS = {
  background: "#ffffff",
  cream: "#fffdf7",
  ink: "#1f2937",
  muted: "#4b5563",
  kesari: "#c9450c",
} as const;
