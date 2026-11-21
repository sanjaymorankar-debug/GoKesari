/**
 * The Android app download from gokesari.com (owner, 21-Nov-2026 09.20 IST: no Play Store access yet, so the app is
 * installed from the website). Serves the APK file named by MOBILE_APP_ANDROID_APK_PATH on the server, or redirects
 * to MOBILE_APP_ANDROID_APK_URL; 404 with a plain message when neither is set.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const url = process.env.MOBILE_APP_ANDROID_APK_URL?.trim();
  if (url && /^https:\/\//.test(url)) return Response.redirect(url, 302);
  const path = process.env.MOBILE_APP_ANDROID_APK_PATH?.trim();
  if (path) {
    try {
      const info = await stat(path);
      if (info.isFile()) {
        return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
          headers: {
            "content-type": "application/vnd.android.package-archive",
            "content-length": String(info.size),
            "content-disposition": 'attachment; filename="GoKesari.apk"',
            "cache-control": "no-store",
          },
        });
      }
    } catch {
      // fall through to the message below
    }
  }
  return new Response("The Android app download is not available yet. Please try again later.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}
