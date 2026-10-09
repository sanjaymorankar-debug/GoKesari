/**
 * iOS Universal Links: lets the GoKesari app open links to this site (mobile/
 * README.md, "Deep links"). Apple requires this exact path, no extension, as
 * application/json. 404 until MOBILE_IOS_APP_IDS is set.
 */
import { mobileAppLinkConfig } from "@/lib/env";
import { appleAppSiteAssociation } from "@/lib/mobile-app";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const { iosAppIds } = mobileAppLinkConfig();
  if (iosAppIds.length === 0) return new Response("Not found", { status: 404 });
  return Response.json(appleAppSiteAssociation(iosAppIds), {
    headers: { "cache-control": "public, max-age=3600" },
  });
}
