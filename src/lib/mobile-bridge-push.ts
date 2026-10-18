/**
 * The website's side of push registration in the GoKesari app (F13.1.2).
 *
 * Inside the app every page has `window.__gokesariApp` (mobile/src/bridge-script.ts).
 * Once the site knows someone is signed in (the notification bell renders),
 * it asks the app for this phone's Expo push token — the app asks the person
 * for notification permission the first time — and registers it with
 * POST /api/push-tokens. Once per signed-in person per app session; nothing
 * happens in a normal browser or in an older app without push.
 */

export interface AppPushRegistration {
  token: string;
  platform: "android" | "ios";
  appVariant: "production" | "preview";
  deviceId?: string | null;
  deviceName?: string | null;
}

interface AppBridge {
  platform?: string;
  version?: string;
  getPushToken?: () => Promise<unknown>;
}

export type PushRegistrationOutcome = "registered" | "already" | "not-in-app" | "unsupported" | "denied" | "failed";

export function appBridge(win: unknown = typeof window === "undefined" ? undefined : window): AppBridge | null {
  const bridge = (win as { __gokesariApp?: AppBridge } | undefined)?.__gokesariApp;
  return bridge && typeof bridge === "object" ? bridge : null;
}

export function isAppPushRegistration(value: unknown): value is AppPushRegistration {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.token === "string" &&
    /^Expo(nent)?PushToken\[[A-Za-z0-9_\-:.]+\]$/.test(v.token) &&
    (v.platform === "android" || v.platform === "ios") &&
    (v.appVariant === "production" || v.appVariant === "preview")
  );
}

const storageKey = (userId: string) => `gk-push:${userId}`;

export async function registerAppPushToken(
  userId: string,
  deps: {
    win?: unknown;
    fetchImpl?: typeof fetch;
    storage?: Pick<Storage, "getItem" | "setItem"> | null;
  } = {},
): Promise<PushRegistrationOutcome> {
  const bridge = appBridge(deps.win);
  if (!bridge) return "not-in-app";
  if (typeof bridge.getPushToken !== "function") return "unsupported";
  const storage =
    deps.storage !== undefined
      ? deps.storage
      : (() => {
          try {
            return window.sessionStorage;
          } catch {
            return null;
          }
        })();

  // Once per person per app session: asking the app means a round trip to Expo for the token.
  try {
    if (storage?.getItem(storageKey(userId))) return "already";
  } catch {
    // storage blocked: register again, the server is idempotent
  }
  let registration: unknown;
  try {
    registration = await bridge.getPushToken();
  } catch {
    return "denied";
  }
  if (!isAppPushRegistration(registration)) return "denied";

  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const response = await doFetch("/api/push-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: registration.token,
        platform: registration.platform,
        appVariant: registration.appVariant,
        deviceId: registration.deviceId ?? null,
        deviceName: registration.deviceName ?? null,
      }),
    });
    if (!response.ok) return "failed";
  } catch {
    return "failed";
  }
  try {
    storage?.setItem(storageKey(userId), registration.token);
  } catch {
    // fine — the next page registers again
  }
  return "registered";
}
