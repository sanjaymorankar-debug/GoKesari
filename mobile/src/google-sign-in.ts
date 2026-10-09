/**
 * "Continue with Google" from inside the app.
 *
 * Google blocks sign-in inside embedded WebViews ("disallowed_useragent"), so
 * the app runs it in the system browser — ASWebAuthenticationSession on iOS,
 * a Custom Tab on Android — and the website hands back a one-time code
 * (website: src/server/mobile-auth.ts). The code is bound by PKCE to a
 * verifier made here and kept in memory only, so another app that grabs the
 * `<scheme>://auth-callback` link cannot use it.
 */
import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";

import { APP_SCHEME, SITE_URL } from "./config";
import { base64ToBase64Url, bytesToBase64Url } from "./pkce";
import { parseUrl, queryParam } from "./url";

export type GoogleSignInResult =
  /** Load this in the WebView to finish: it carries the code and verifier in the fragment. */
  | { status: "success"; finishUrl: string }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

let inProgress = false;

export async function signInWithGoogle(): Promise<GoogleSignInResult> {
  if (inProgress) return { status: "cancelled" };
  inProgress = true;
  try {
    const verifier = bytesToBase64Url(Crypto.getRandomBytes(32));
    const challenge = base64ToBase64Url(
      await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
        encoding: Crypto.CryptoEncoding.BASE64,
      }),
    );
    const startUrl = `${SITE_URL}/mobile-auth/start?app=${encodeURIComponent(APP_SCHEME)}&challenge=${challenge}`;
    const result = await WebBrowser.openAuthSessionAsync(startUrl, `${APP_SCHEME}://auth-callback`);
    if (result.type !== "success") return { status: "cancelled" };

    const callback = parseUrl(result.url);
    const code = callback ? queryParam(callback.query, "code") : null;
    if (!code) return { status: "failed", message: "Google sign-in did not finish. Please try again." };
    return {
      status: "success",
      finishUrl: `${SITE_URL}/mobile-auth/finish#code=${encodeURIComponent(code)}&verifier=${verifier}`,
    };
  } catch {
    return { status: "failed", message: "Could not open Google sign-in. Please try again." };
  } finally {
    inProgress = false;
  }
}
