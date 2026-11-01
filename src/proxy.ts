/**
 * Edge-of-app guard (Hostinger process-limit work).
 *
 * Runs before routes render, in the same Node process, so it costs no extra
 * process and — importantly — opens no database connection.
 *
 *  1. /api/cron/* except every-minute, hourly, daily — CRON_ROUTES_ENABLED !== "true"
 *     (the default): 410 Gone straight away. When enabled: the x-cron-secret header (or the legacy
 *     "Authorization: Bearer") must equal CRON_SECRET, compared in constant
 *     time, else 401 — all before any handler or DB work.
 *  2. Test site (TEST_SITE_BASIC_AUTH="user:pass" set): HTTP basic auth on every
 *     page and API call, plus X-Robots-Tag: noindex. Leave unset on production.
 *  3. Pages — D-23: remember the page being opened (24 h cookie) so signing in
 *     again comes back to it (src/lib/return-to.ts).
 *  4. /api/* — a light per-IP in-memory rate limit (API_RATE_LIMIT_PER_MIN,
 *     default 240, 0 = off). Webhooks and cron are exempt.
 */
import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { RETURN_TO_COOKIE, RETURN_TO_MAX_AGE_S, safeReturnPath } from "@/lib/return-to";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string, limit: number): boolean {
  const now = Date.now();
  if (hits.size > 10_000) {
    for (const [key, w] of hits) if (w.resetAt <= now) hits.delete(key);
  }
  const w = hits.get(ip);
  if (!w || w.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  w.count += 1;
  return w.count > limit;
}

function clientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/api/cron/") || pathname === "/api/cron") {
    // The three consolidated entry points (docs/cron-schedule.md) are the live safety net
    // (timeouts, payment reconcile, payouts) and stay on; only the legacy per-job
    // routes are retired unless CRON_ROUTES_ENABLED=true.
    const entryPoint = /^\/api\/cron\/(every-minute|hourly|daily)\/?$/.test(pathname);
    if (!entryPoint && process.env.CRON_ROUTES_ENABLED !== "true") {
      return NextResponse.json({ error: "Gone", message: "Scheduled endpoints are disabled." }, { status: 410 });
    }
    const secret = process.env.CRON_SECRET ?? "";
    const bearer = request.headers.get("authorization") ?? "";
    const provided =
      request.headers.get("x-cron-secret") ?? (bearer.startsWith("Bearer ") ? bearer.slice(7) : "");
    if (!secret || !safeEqual(provided, secret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  const basic = process.env.TEST_SITE_BASIC_AUTH;
  // Billing v2: the desktop connector and the public API carry their own bearer tokens in the
  // Authorization header, so the test site's basic auth would lock them out; they check themselves.
  const ownBearerAuth = /^\/api\/(connector|public)\/v1\//.test(pathname);
  if (basic && !ownBearerAuth) {
    const header = request.headers.get("authorization") ?? "";
    const given = header.startsWith("Basic ") ? atob(header.slice(6)) : "";
    if (!safeEqual(given, basic)) {
      return new NextResponse("Authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="GoKesari test"', "X-Robots-Tag": "noindex, nofollow" },
      });
    }
  }

  if (pathname.startsWith("/api/") && !/webhook/i.test(pathname)) {
    const limit = Number(process.env.API_RATE_LIMIT_PER_MIN ?? 240);
    if (limit > 0 && rateLimited(clientIp(request), limit)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": "60" } });
    }
  }

  const response = NextResponse.next();
  if (basic) response.headers.set("X-Robots-Tag", "noindex, nofollow");
  rememberReturnTo(request, response);
  return response;
}

function rememberReturnTo(request: NextRequest, response: NextResponse): void {
  if (request.nextUrl.pathname.startsWith("/api/")) return;
  // Page navigations only: not form posts or server actions, and not links the router prefetches.
  if (request.method !== "GET" || request.headers.has("next-router-prefetch") || /prefetch/i.test(request.headers.get("sec-purpose") ?? request.headers.get("purpose") ?? "")) {
    return;
  }
  const path = safeReturnPath(request.nextUrl.pathname + request.nextUrl.search);
  if (!path || request.cookies.get(RETURN_TO_COOKIE)?.value === path) return;
  response.cookies.set(RETURN_TO_COOKIE, path, {
    maxAge: RETURN_TO_MAX_AGE_S,
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png).*)"],
};
