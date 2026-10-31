/**
 * docs/app-install-2026-10: checks for a newer app build at launch and when
 * the app returns to the screen, and offers it ("Update" opens the Play Store
 * / App Store listing, or the APK download until the app is listed). The
 * update installs over this one: sign-in and settings stay. Rules in
 * ./app-update-policy.ts.
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
let laterFor: string | null = null;
let showing = false;

export async function checkForUpdate(): Promise<void> {
  if (showing || Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
  lastCheck = Date.now();
  const platform = Platform.OS === "ios" ? "ios" : "android";
  const all = (await getJson(`${SITE_URL}/api/app/version`)) as Record<string, ReleaseInfo> | null;
  const info = all?.[platform] ?? null;
  const decision = decideUpdate(APP_VERSION, info, await appStoreListing(info));
  if (decision.kind === "none" || (decision.kind === "optional" && laterFor === decision.version)) return;

  const open = () => {
    showing = false;
    void Linking.openURL(storeOpenUrl(decision.url)).catch(() => Linking.openURL(decision.url).catch(() => {}));
    // A required update stays on screen until the new version is installed.
    if (decision.kind === "required") lastCheck = 0;
  };
  showing = true;
  Alert.alert(
    decision.kind === "required" ? "Update GoKesari to continue" : "A new version of GoKesari is ready",
    `Version ${decision.version} is available. It installs over this one — you stay signed in.`,
    decision.kind === "required"
      ? [{ text: "Update", onPress: open }]
      : [
          {
            text: "Later",
            style: "cancel",
            onPress: () => {
              showing = false;
              laterFor = decision.version;
            },
          },
          { text: "Update", onPress: open },
        ],
    { cancelable: decision.kind !== "required", onDismiss: () => void (showing = false) },
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
