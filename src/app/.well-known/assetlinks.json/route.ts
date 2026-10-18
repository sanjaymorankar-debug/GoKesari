/**
 * Android App Links: lets the GoKesari app open links to this site (mobile/
 * README.md, "Deep links"; docs/deep-links-activation.md). Host-aware:
 * gokesari.com lists com.gokesari.app, test.gokesari.com
 * com.gokesari.app.preview (MOBILE_ANDROID_PACKAGE overrides). Served always:
 * until MOBILE_ANDROID_CERT_SHA256 is set the fingerprint is the literal
 * placeholder REPLACE_WITH_SHA256_SIGNING_FINGERPRINT, which Android's
 * verification rejects — links then simply open in the browser.
 */
import { assetLinksFor, requestHost } from "@/lib/deep-links";

export const dynamic = "force-dynamic";

export function GET(request?: Request): Response {
  const { body, placeholder } = assetLinksFor(requestHost(request));
  return Response.json(body, {
    headers: { "cache-control": placeholder ? "public, max-age=300" : "public, max-age=3600" },
  });
}
