/**
 * D-23: remembers the page being opened (24 h cookie) so that signing in
 * again — after a session ran out, or from a page's "Sign in" link — comes
 * back to it (src/lib/return-to.ts, src/app/onboarding/page.tsx).
 */
import { NextResponse, type NextRequest } from "next/server";

import { RETURN_TO_COOKIE, RETURN_TO_MAX_AGE_S, safeReturnPath } from "@/lib/return-to";

export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  // Page navigations only: not form posts or server actions, and not links the router prefetches.
  if (request.method !== "GET" || request.headers.has("next-router-prefetch") || /prefetch/i.test(request.headers.get("sec-purpose") ?? request.headers.get("purpose") ?? "")) {
    return response;
  }
  const path = safeReturnPath(request.nextUrl.pathname + request.nextUrl.search);
  if (!path || request.cookies.get(RETURN_TO_COOKIE)?.value === path) return response;
  response.cookies.set(RETURN_TO_COOKIE, path, {
    maxAge: RETURN_TO_MAX_AGE_S,
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
  });
  return response;
}

export const config = {
  // Not API routes, build files or images.
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico).*)"],
};
