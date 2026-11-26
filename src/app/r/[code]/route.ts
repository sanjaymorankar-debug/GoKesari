/**
 * F11: a referral link. Remembers the code for 30 days and sends the visitor to sign in (or, when
 * signed in, to the referral page to apply it).
 * Shop-refers-shop (0137): a shop's code (SHOP…) goes to Add my shop with the code filled in, while
 * rule shopReferrals is on.
 *
 * Referral sharing (docs/referral-sharing-2026-11, rule referralSharing):
 *   - dealer, team lead, agent and franchise codes (GKD- / GKT- / GKA- / GKF-, hyphen kept) go to
 *     Add my shop with the code filled in, like a dealer's /shop/register?ref= link;
 *   - a closed or expired code goes to /invite/<code>, which says why; an unknown code keeps the
 *     original behaviour (remembered, checked later by the form it reaches), as before;
 *   - first valid link wins: a gk_ref cookie from an earlier valid link is kept;
 *   - opening your own link is logged as SELF and changes nothing;
 *   - every click is logged with its channel (?c=wa|sms|em|sh|cp|qr).
 * With the rule off, the original behaviour above is unchanged.
 */
import { NextResponse, type NextRequest } from "next/server";

import { REFERRAL_COOKIE, REFERRAL_LINK_COOKIE } from "@/lib/customer-referrals";
import { isMobileAppUserAgent } from "@/lib/mobile-app";
import { channelFromTag } from "@/lib/referral-share";
import { getCurrentUser } from "@/server/authz/guards";
import { normalizeReferralCode } from "@/server/services/customer-referrals";
import { landingPathFor, logReferralEvent, referralSharingOn, resolveReferralLink } from "@/server/services/referral-links";
import { looksLikeShopCode, shopReferralRule } from "@/server/services/shop-referrals";

const cookieOptions = (request: NextRequest) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: request.nextUrl.protocol === "https:",
  path: "/",
  maxAge: 30 * 24 * 3600,
});

export async function GET(request: NextRequest, context: { params: Promise<{ code: string }> }) {
  const { code } = await context.params;
  if (await referralSharingOn()) return sharedLink(request, code);
  return originalLink(request, code);
}

/** The original route (rule referralSharing off, and unknown codes with it on). */
async function originalLink(request: NextRequest, code: string) {
  const clean = normalizeReferralCode(code).slice(0, 16);
  if (looksLikeShopCode(clean) && (await shopReferralRule()).enabled) {
    return new NextResponse(null, { status: 307, headers: { Location: `/shop/register?ref=${clean}` } });
  }
  const user = await getCurrentUser();
  // Relative Location: behind the host's proxy request.url carries the
  // internal address (0.0.0.0:3000), not the public domain.
  const response = new NextResponse(null, { status: 307, headers: { Location: user ? "/refer" : "/signin" } });
  if (clean) response.cookies.set(REFERRAL_COOKIE, clean, cookieOptions(request));
  return response;
}

async function sharedLink(request: NextRequest, rawCode: string) {
  const target = await resolveReferralLink(decodeURIComponent(rawCode));
  const user = await getCurrentUser();
  const channel = channelFromTag(request.nextUrl.searchParams.get("c"));
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
  const inApp = isMobileAppUserAgent(request.headers.get("user-agent"));
  const log = (outcome: string) =>
    logReferralEvent({ code: target.code, kind: target.kind, event: "CLICK", channel, outcome, referrerUserId: target.referrerUserId, actorUserId: user?.id ?? null, ip, inApp });

  if (target.outcome === "INVALID") {
    // Not a code we know: logged, then the original behaviour (the form it reaches says it is not valid).
    await log(target.outcome);
    return originalLink(request, rawCode);
  }
  if (!target.usable) {
    await log(target.outcome);
    return new NextResponse(null, { status: 307, headers: { Location: `/invite/${encodeURIComponent(target.code || "-")}` } });
  }
  if (user && target.referrerUserId === user.id) {
    // Your own link: nothing to apply. Customers see their referral page, partners their own.
    await log("SELF");
    return new NextResponse(null, { status: 307, headers: { Location: target.audience === "shop-owner" ? "/referrals" : "/refer" } });
  }

  const earlier = request.cookies.get(REFERRAL_LINK_COOKIE)?.value;
  let winner = target;
  if (earlier && earlier !== target.code) {
    const first = await resolveReferralLink(earlier);
    if (first.usable && first.audience === target.audience && first.referrerUserId !== user?.id) winner = first;
  }
  const keptFirst = winner !== target;
  await log(keptFirst ? "KEPT_FIRST" : "OK");

  const response = new NextResponse(null, { status: 307, headers: { Location: landingPathFor(winner, Boolean(user)) } });
  if (!keptFirst) {
    response.cookies.set(REFERRAL_LINK_COOKIE, target.code, cookieOptions(request));
    // Customer first-time setup reads gk_ref (unchanged): only customer-audience codes go there.
    if (target.audience === "customer") response.cookies.set(REFERRAL_COOKIE, target.code, cookieOptions(request));
  }
  return response;
}
