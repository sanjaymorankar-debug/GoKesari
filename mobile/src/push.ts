/**
 * Push notifications (F13.1.2): the native half. The website sends pushes
 * through Expo's push service to the token this file obtains; tapping one
 * opens its link inside the app.
 *
 *   getPushRegistration()  asks for permission (once; the OS remembers),
 *                          creates the Android channel, returns the Expo token
 *                          for the bridge message "push.getToken"
 *   onNotificationTap()    calls back with the tapped notification's data,
 *                          also for the tap that launched the app
 *
 * Android needs Firebase credentials in the build (google-services.json —
 * app.config.ts reads GOOGLE_SERVICES_JSON) and the FCM key uploaded to Expo;
 * iOS needs the APNs key, which EAS creates. Without them the token request
 * fails and the page is told push is not available — nothing else changes.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { APP_VARIANT } from "./config";
import { buildPushRegistration, PUSH_PERMISSION_DENIED, type PushRegistration } from "./push-registration";

/** Must match rule push.androidChannelId on the website (default "default"). */
export const ANDROID_CHANNEL_ID = "default";

let configured = false;

/** Shows notifications that arrive while the app is open (banner + list, with sound). */
export function configureNotifications(): void {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export async function getPushRegistration(): Promise<PushRegistration> {
  if (!Device.isDevice) throw { name: "NotSupportedError", message: "Push notifications need a real phone." };
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
      name: "GoKesari",
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: "#c9450c",
    });
  }
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) throw PUSH_PERMISSION_DENIED;

  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  const { data } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  return buildPushRegistration({ token: data, platform: Platform.OS, appVariant: APP_VARIANT, deviceName: Device.modelName });
}

/** Calls `onTap` with each tapped notification's data, including the tap that opened the app. Returns an unsubscribe. */
export function onNotificationTap(onTap: (data: unknown) => void): () => void {
  let handledLaunch = false;
  const handle = (response: Notifications.NotificationResponse | null) => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    onTap(response.notification.request.content.data);
  };
  void Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (handledLaunch) return;
      handledLaunch = true;
      handle(response);
      void Notifications.clearLastNotificationResponseAsync().catch(() => {});
    })
    .catch(() => {});
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    handledLaunch = true;
    handle(response);
  });
  return () => subscription.remove();
}
