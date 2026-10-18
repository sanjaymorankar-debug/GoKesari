/**
 * iOS Universal Links: lets the GoKesari app open links to this site (mobile/
 * README.md, "Deep links"; docs/deep-links-activation.md). Apple requires this
 * exact path, no extension, as application/json. Host-aware: the store app on
 * gokesari.com, the preview app on test.gokesari.com. Served always: until
 * MOBILE_IOS_APP_IDS is set the app id is REPLACE_WITH_APPLE_TEAM_ID.<bundle id>,
 * which no app matches — links then simply open in Safari.
 */
import { appleAssociationFor, requestHost } from "@/lib/deep-links";

export const dynamic = "force-dynamic";

export function GET(request?: Request): Response {
  const { body, placeholder } = appleAssociationFor(requestHost(request));
  return Response.json(body, {
    headers: {
      "content-type": "application/json",
      "cache-control": placeholder ? "public, max-age=300" : "public, max-age=3600",
    },
  });
}
