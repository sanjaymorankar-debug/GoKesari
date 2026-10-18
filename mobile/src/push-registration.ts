/**
 * The bridge's push message (F13.1.2), in plain TypeScript so it is unit-tested.
 *
 * The website asks `window.__gokesariApp.getPushToken()` after sign-in; the
 * app answers with this registration (or an error), and the website posts it
 * to /api/push-tokens. The shape must match isAppPushRegistration in
 * src/lib/mobile-bridge-push.ts at the repository root.
 */
export type AppVariant = "production" | "preview";

export interface PushRegistration {
  token: string;
  platform: "android" | "ios";
  appVariant: AppVariant;
  deviceId: string | null;
  deviceName: string | null;
}

export const PUSH_TOKEN_MESSAGE = "push.getToken";

export function isExpoPushToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && /^Expo(nent)?PushToken\[[A-Za-z0-9_\-:.]+\]$/.test(value);
}

export function buildPushRegistration(input: {
  token: unknown;
  platform: string;
  appVariant: unknown;
  deviceName?: string | null;
}): PushRegistration {
  if (!isExpoPushToken(input.token)) throw { name: "NotSupportedError", message: "No push token is available on this phone." };
  return {
    token: input.token,
    platform: input.platform === "ios" ? "ios" : "android",
    appVariant: input.appVariant === "preview" ? "preview" : "production",
    deviceId: null,
    deviceName: input.deviceName ? String(input.deviceName).slice(0, 200) : null,
  };
}

/** The error the page sees when the person said no to notifications. */
export const PUSH_PERMISSION_DENIED = { name: "NotAllowedError", message: "Notifications are switched off for GoKesari." } as const;
