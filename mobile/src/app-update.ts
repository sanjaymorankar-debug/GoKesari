/**
 * docs/app-install-2026-10: checks for a newer app build at launch and when
 * the app returns to the screen. Rules in ./app-update-policy.ts.
 *
 * docs/silent-update-2026-11 (1.16.0): no "new version is ready" popup any
 * more. The page inside the app is the live website, so website changes
 * reach everyone at once without any app update. A newer native build is
 * left to the store's own automatic updates (Play Store / App Store). Only a
 * build below the minimum the website names (MOBILE_APP_*_MINIMUM, set by
 * the owner for a critical breaking change) still asks: "Update" opens the
 * store listing, or the APK download until the app is listed. The update
 * installs over this one: sign-in and settings stay.
 */
import Constants from "expo-constants";
import { Alert, AppState, Linking, Platform } from "react-native";

import { decideUpdate, parseAppStoreLookup, storeOpenUrl, UPDATE_CHECK_INTERVAL_MS, type AppStoreListing, type ReleaseInfo } from "./app-update-policy";
import { APP_VERSION, SITE_URL } from "./config";

const TIMEOUT_MS = 8000;

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function appStoreListing(info: ReleaseInfo | null): Promise<AppStoreListing | null> {
  // Asked only once the site names an App Store listing: before that there is nothing to look up.
  const bundleId = Constants.expoConfig?.ios?.bundleIdentifier;
  if (Platform.OS !== "ios" || !bundleId || !info?.url?.startsWith("https://apps.apple.com/")) return null;
  return parseAppStoreLookup(await getJson(`https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}&country=in`));
}

let lastCheck = 0;
let showing = false;

export async function checkForUpdate(): Promise<void> {
  if (showing || Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
  lastCheck = Date.now();
  const platform = Platform.OS === "ios" ? "ios" : "android";
  const all = (await getJson(`${SITE_URL}/api/app/version`)) as Record<string, ReleaseInfo> | null;
  const info = all?.[platform] ?? null;
  const decision = decideUpdate(APP_VERSION, info, await appStoreListing(info));
  // docs/silent-update-2026-11: a newer optional build is never announced (the store updates it in the background).
  if (decision.kind !== "required") return;

  const open = () => {
    showing = false;
    void Linking.openURL(storeOpenUrl(decision.url)).catch(() => Linking.openURL(decision.url).catch(() => {}));
    // A required update stays on screen until the new version is installed.
    lastCheck = 0;
  };
  showing = true;
  Alert.alert(
    "Update GoKesari to continue",
    `Version ${decision.version} is available. It installs over this one — you stay signed in.`,
    [{ text: "Update", onPress: open }],
    { cancelable: false, onDismiss: () => void (showing = false) },
  );
}

/** Starts the checks; returns the cleanup for the app's effect. */
export function watchForUpdates(): () => void {
  void checkForUpdate();
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") void checkForUpdate();
  });
  return () => subscription.remove();
}
