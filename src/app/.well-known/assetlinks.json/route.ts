/**
 * Android App Links: lets the GoKesari app open links to this site (mobile/
 * README.md, "Deep links"). 404 until MOBILE_ANDROID_CERT_SHA256 is set.
 */
import { mobileAppLinkConfig } from "@/lib/env";
import { androidAssetLinks } from "@/lib/mobile-app";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const { androidPackage, androidCertFingerprints } = mobileAppLinkConfig();
  if (androidCertFingerprints.length === 0) return new Response("Not found", { status: 404 });
  return Response.json(androidAssetLinks(androidPackage, androidCertFingerprints), {
    headers: { "cache-control": "public, max-age=3600" },
  });
}
