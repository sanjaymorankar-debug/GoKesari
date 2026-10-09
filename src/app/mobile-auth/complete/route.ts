/**
 * Step 2 of the app's Google sign-in (src/server/mobile-auth.ts): Google has
 * signed the user in to this browser; hand the app a code it can trade, with
 * its verifier, for a session of its own.
 */
import { cookies } from "next/headers";

import { isMobileAppScheme, mobileAuthCallbackUrl } from "@/lib/mobile-app";
import { getCurrentUser } from "@/server/authz/guards";
import { MOBILE_AUTH_COOKIE, createMobileAuthCode, isValidChallenge } from "@/server/mobile-auth";

import { browserPage } from "../browser-page";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const store = await cookies();
  const saved = store.get(MOBILE_AUTH_COOKIE)?.value ?? "";
  const dot = saved.indexOf(".");
  const app = saved.slice(0, dot);
  const challenge = saved.slice(dot + 1);
  if (dot < 0 || !isMobileAppScheme(app) || !isValidChallenge(challenge)) {
    return browserPage({
      status: 400,
      title: "This sign-in has expired",
      message: "Go back to the GoKesari app and tap Continue with Google again.",
    });
  }

  const user = await getCurrentUser();
  if (!user) {
    return browserPage({
      status: 401,
      title: "Sign-in did not finish",
      message: "Go back to the GoKesari app and try again.",
    });
  }

  store.delete({ name: MOBILE_AUTH_COOKIE, path: "/mobile-auth" });
  return browserPage({
    status: 200,
    title: "You're signed in",
    message: "Returning you to the GoKesari app…",
    continueUrl: mobileAuthCallbackUrl(app, createMobileAuthCode(user.id, challenge)),
  });
}
