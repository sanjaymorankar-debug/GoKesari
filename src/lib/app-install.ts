/**
 * "Install the GoKesari app" prompt and app updates (docs/app-install-2026-10).
 *
 * Rules (owner brief, 31 Oct 2026):
 *  - The prompt shows on every visit until the app is installed. "Not now"
 *    hides it for that page view only; a decline is counted, never used to
 *    stop prompting.
 *  - It never shows once the app is installed: inside the native app (its
 *    user agent), in the installed web app (standalone display mode), when the
 *    browser reports a related app installed, or once this device — or, for a
 *    signed-in person, the same platform on their account — recorded an install.
 *
 * No browser or server imports: shared by the prompt, the API and unit tests.
 */
import { isMobileAppUserAgent } from "@/lib/mobile-app";

/** localStorage keys (per device). */
export const INSTALL_STORAGE = {
  /** ISO time the app was installed on this device. */
  installed: "gk_app_installed",
  /** JSON { count, lastAt }: how often "Not now" was pressed (kept for the record, never suppresses). */
  declines: "gk_app_install_declines",
} as const;

export type InstallPlatform = "android" | "ios" | "desktop";

/**
 * How the "Install" button installs:
 *  - native-prompt  Chrome / Edge / Samsung Internet: the browser's own install dialog (beforeinstallprompt)
 *  - store          a store listing (Play Store / App Store) is configured for this platform
 *  - ios-guide      iPhone / iPad: Share → Add to Home Screen, with a picture guide
 *  - android-menu   Android browser without the install event yet: ⋮ menu → Install app
 */
export type InstallMethod = "native-prompt" | "store" | "ios-guide" | "android-menu";

export const INSTALL_EVENTS = ["declined", "installed", "uninstalled"] as const;
export type InstallEvent = (typeof INSTALL_EVENTS)[number];

export function installPlatform(userAgent: string, maxTouchPoints = 0): InstallPlatform {
  if (/android/i.test(userAgent)) return "android";
  if (/iphone|ipad|ipod/i.test(userAgent)) return "ios";
  // iPadOS 13+ reports itself as a Mac; a Mac has no touch screen.
  if (/macintosh/i.test(userAgent) && maxTouchPoints > 1) return "ios";
  return "desktop";
}

/** Store listings, from the server's environment (empty until the apps are published). */
export interface StoreLinks {
  android: string | null;
  ios: string | null;
}

/** Accepts only https links to the two stores, so a typo in the environment cannot send people elsewhere. */
export function parseStoreLink(value: string | undefined, platform: "android" | "ios"): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const hosts = platform === "android" ? ["play.google.com"] : ["apps.apple.com"];
    return url.protocol === "https:" && hosts.includes(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

export interface InstallSignals {
  userAgent: string;
  maxTouchPoints?: number;
  /** matchMedia("(display-mode: standalone)") or iOS navigator.standalone. */
  standalone: boolean;
  /** navigator.getInstalledRelatedApps() found GoKesari (Android Chrome). */
  relatedAppInstalled: boolean;
  /** This device recorded an install (localStorage). */
  installedOnDevice: boolean;
  /** Platforms the signed-in person's account recorded an install on. */
  accountInstalledOn: readonly InstallPlatform[];
  /** The browser fired beforeinstallprompt and the event is held. */
  hasInstallEvent: boolean;
  stores: StoreLinks;
}

export type InstallDecision = { show: false; reason: string } | { show: true; platform: InstallPlatform; method: InstallMethod };

export function decideInstallPrompt(s: InstallSignals): InstallDecision {
  if (isMobileAppUserAgent(s.userAgent)) return { show: false, reason: "native-app" };
  if (s.standalone) return { show: false, reason: "standalone" };
  if (s.relatedAppInstalled) return { show: false, reason: "related-app" };
  if (s.installedOnDevice) return { show: false, reason: "installed-on-device" };
  const platform = installPlatform(s.userAgent, s.maxTouchPoints);
  if (s.accountInstalledOn.includes(platform)) return { show: false, reason: "installed-on-account" };

  if (platform === "android") {
    if (s.stores.android) return { show: true, platform, method: "store" };
    return { show: true, platform, method: s.hasInstallEvent ? "native-prompt" : "android-menu" };
  }
  if (platform === "ios") {
    return { show: true, platform, method: s.stores.ios ? "store" : "ios-guide" };
  }
  // Computers: only where the browser itself can install (Chrome, Edge); no instructions otherwise.
  return s.hasInstallEvent ? { show: true, platform, method: "native-prompt" } : { show: false, reason: "desktop-no-install" };
}

/** Reads the stored decline record; anything unreadable is "no declines yet". */
export function readDeclines(raw: string | null): { count: number; lastAt: string | null } {
  try {
    const value = JSON.parse(raw ?? "null") as { count?: unknown; lastAt?: unknown } | null;
    const count = typeof value?.count === "number" && Number.isFinite(value.count) && value.count >= 0 ? Math.floor(value.count) : 0;
    return { count, lastAt: typeof value?.lastAt === "string" ? value.lastAt : null };
  } catch {
    return { count: 0, lastAt: null };
  }
}

/* ------------------------------------------------------------ app updates */

/** "1.4.0" → [1, 4, 0]; null for anything that is not three numbers. */
export function parseVersion(value: string | null | undefined): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value?.trim() ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative when a < b, 0 when equal, positive when a > b. Unparseable versions compare equal. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** What GET /api/app/version tells the native app, per platform. */
export interface NativeReleaseInfo {
  /** Newest version people can install now; null = no update offered. */
  latest: string | null;
  /** Versions below this must update before carrying on; null = none. */
  minimum: string | null;
  /** Where the update comes from (store listing or APK download); null = nowhere yet. */
  url: string | null;
}

/** Reads one platform's release info from environment values; invalid entries become null. */
export function nativeReleaseInfo(latest: string | undefined, minimum: string | undefined, url: string | undefined): NativeReleaseInfo {
  let safeUrl: string | null = null;
  try {
    if (url?.trim() && new URL(url.trim()).protocol === "https:") safeUrl = new URL(url.trim()).toString();
  } catch {
    safeUrl = null;
  }
  return {
    latest: parseVersion(latest) ? latest!.trim() : null,
    minimum: parseVersion(minimum) ? minimum!.trim() : null,
    url: safeUrl,
  };
}
