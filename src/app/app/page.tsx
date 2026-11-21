/**
 * Get the GoKesari app (owner, 21-Nov-2026 09.20 IST). Until the Play Store and App Store listings exist, Android
 * installs the app from gokesari.com (APK) and iPhone adds GoKesari to the Home Screen from Safari.
 */
import { Card, LinkButton, PageHeader } from "@/components/ui";

export const metadata = { title: "Get the GoKesari app", description: "Install the GoKesari app on Android or add GoKesari to your iPhone's Home Screen." };
export const dynamic = "force-dynamic";

export default function GetTheAppPage() {
  const androidReady = !!(process.env.MOBILE_APP_ANDROID_APK_PATH?.trim() || process.env.MOBILE_APP_ANDROID_APK_URL?.trim());
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6" data-testid="get-the-app">
      <PageHeader title="Get the GoKesari app" description="Shop, sell, deliver and manage your franchise from your phone." />
      <Card className="space-y-3 p-4">
        <h2 className="text-lg font-bold text-ink-900">Android</h2>
        {androidReady ? (
          <>
            <LinkButton href="/app/download/android" data-testid="android-apk-download">
              Download the Android app
            </LinkButton>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-700">
              <li>Tap the button above; the file GoKesari.apk downloads.</li>
              <li>Open it. If Android asks, allow your browser to install apps (Settings → “Install unknown apps”).</li>
              <li>Tap Install, then Open. Later updates install over it in the same way.</li>
            </ol>
            <p className="text-xs text-ink-500">The app will also come to the Google Play Store; until then, install it only from gokesari.com.</p>
          </>
        ) : (
          <p className="text-sm text-ink-700">The Android download opens shortly. Meanwhile, open gokesari.com in Chrome and tap “Install” or “Add to Home screen”.</p>
        )}
      </Card>
      <Card className="space-y-3 p-4">
        <h2 className="text-lg font-bold text-ink-900">iPhone and iPad</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-700">
          <li>Open gokesari.com in Safari.</li>
          <li>Tap the Share button, then “Add to Home Screen”.</li>
          <li>Open GoKesari from your Home Screen: it opens full screen, like an app.</li>
        </ol>
        <p className="text-xs text-ink-500">The App Store version comes later.</p>
      </Card>
    </div>
  );
}
