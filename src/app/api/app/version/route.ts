/**
 * docs/app-install-2026-10: newest GoKesari app version per platform, for the
 * native app's update check (mobile/src/app-update.ts). Public; read from the
 * environment so a version is offered only once it can actually be installed:
 *
 *   MOBILE_APP_ANDROID_LATEST / _MINIMUM / _URL   (URL: Play listing or the APK download)
 *   MOBILE_APP_IOS_LATEST / _MINIMUM / _URL       (URL: App Store listing)
 *
 * Missing or invalid values come back null and the app then offers nothing.
 * On iPhone the app also asks the App Store itself when it has a listing.
 */
import { nativeReleaseInfo } from "@/lib/app-install";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const env = process.env;
  return Response.json(
    {
      android: nativeReleaseInfo(env.MOBILE_APP_ANDROID_LATEST, env.MOBILE_APP_ANDROID_MINIMUM, env.MOBILE_APP_ANDROID_URL),
      ios: nativeReleaseInfo(env.MOBILE_APP_IOS_LATEST, env.MOBILE_APP_IOS_MINIMUM, env.MOBILE_APP_IOS_URL),
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
