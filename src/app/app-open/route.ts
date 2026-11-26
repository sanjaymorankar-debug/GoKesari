/**
 * Deferred referral link (docs/referral-sharing-2026-11; app 1.15.0 src/first-open.ts): the app's very
 * first page after an install. When this phone's network opened a usable referral link in the last
 * deferredMatchHours (rule referralSharing), the code is put into the app's own cookies — exactly as if
 * the link had been opened in the app — and the visitor goes where the link would have sent them,
 * with "Referred by <name>" on the page. Otherwise: the home page. Never applies a code by itself.
 */
import { NextResponse, type NextRequest } from "next/server";

import { REFERRAL_CLAIM_COOKIE, REFERRAL_COOKIE, REFERRAL_LINK_COOKIE } from "@/lib/customer-referrals";
import { isMobileAppUserAgent } from "@/lib/mobile-app";
import { getCurrentUser } from "@/server/authz/guards";
import { claimDeferredReferral, findDeferredReferral, landingPathFor, logReferralEvent } from "@/server/services/referral-links";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const home = new NextResponse(null, { status: 307, headers: { Location: "/" } });
  // Only the app opens this page; a browser that already has a link cookie keeps it.
  if (!isMobileAppUserAgent(request.headers.get("user-agent")) || request.cookies.get(REFERRAL_LINK_COOKIE)) return home;
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
  const user = await getCurrentUser();
  const match = await findDeferredReferral(ip, user?.id ?? null);
  if (!match) return home;
  const { target } = match;
  await logReferralEvent({ code: target.code, kind: target.kind, event: "APP_OPEN", referrerUserId: target.referrerUserId, actorUserId: user?.id ?? null, ip, inApp: true });
  if (user) await claimDeferredReferral(match.eventId, user.id, target, ip, true);
  const response = new NextResponse(null, { status: 307, headers: { Location: landingPathFor(target, Boolean(user)) } });
  const options = { httpOnly: true, sameSite: "lax" as const, secure: request.nextUrl.protocol === "https:", path: "/", maxAge: 30 * 24 * 3600 };
  response.cookies.set(REFERRAL_LINK_COOKIE, target.code, options);
  if (target.audience === "customer") response.cookies.set(REFERRAL_COOKIE, target.code, options);
  // Signed in later: the "Referred by" banner records the claim against the new account (once).
  if (!user) response.cookies.set(REFERRAL_CLAIM_COOKIE, match.eventId, { ...options, maxAge: 7 * 24 * 3600 });
  return response;
}
