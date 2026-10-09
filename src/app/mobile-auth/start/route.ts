/**
 * Step 1 of the app's Google sign-in (src/server/mobile-auth.ts), opened by
 * the app in the system browser: remember which app build asked and its PKCE
 * challenge, then go to Google.
 */
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";

import { getEnv } from "@/lib/env";
import { isMobileAppScheme } from "@/lib/mobile-app";
import { auth, signIn, signOut } from "@/server/auth";
import {
  MOBILE_AUTH_COOKIE,
  MOBILE_AUTH_COOKIE_MAX_AGE_SECONDS,
  isValidChallenge,
} from "@/server/mobile-auth";

import { browserPage } from "../browser-page";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const challenge = request.nextUrl.searchParams.get("challenge");
  const app = request.nextUrl.searchParams.get("app");
  if (!isValidChallenge(challenge) || !isMobileAppScheme(app)) {
    return browserPage({
      status: 400,
      title: "Sign-in link not valid",
      message: "Go back to the GoKesari app and tap Continue with Google again.",
    });
  }

  const env = getEnv();
  if (!env.AUTH_GOOGLE_ID || !env.AUTH_GOOGLE_SECRET) {
    return browserPage({
      status: 503,
      title: "Google sign-in is unavailable",
      message: "Go back to the GoKesari app and sign in with a code sent to your email instead.",
    });
  }

  // A session this browser already holds would make Auth.js link the Google
  // account to that user rather than sign in as it. The website never offers
  // Google to a signed-in visitor either (/signin redirects them away).
  if ((await auth())?.user) await signOut({ redirect: false });

  (await cookies()).set(MOBILE_AUTH_COOKIE, `${app}.${challenge}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/mobile-auth",
    maxAge: MOBILE_AUTH_COOKIE_MAX_AGE_SECONDS,
  });

  // Throws Next's redirect to Google; the cookies above go with it.
  await signIn("google", { redirectTo: "/mobile-auth/complete" });
  return browserPage({ status: 500, title: "Could not start sign-in", message: "Please try again." });
}
