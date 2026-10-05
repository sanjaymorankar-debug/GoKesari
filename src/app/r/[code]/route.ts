/**
 * F11: a customer's referral link. Remembers the code for 30 days and sends
 * the visitor to sign in (or, when signed in, to the referral page to apply it).
 */
import { NextResponse, type NextRequest } from "next/server";

import { REFERRAL_COOKIE } from "@/lib/customer-referrals";
import { getCurrentUser } from "@/server/authz/guards";
import { normalizeReferralCode } from "@/server/services/customer-referrals";

export async function GET(request: NextRequest, context: { params: Promise<{ code: string }> }) {
  const { code } = await context.params;
  const clean = normalizeReferralCode(code).slice(0, 16);
  const user = await getCurrentUser();
  const response = NextResponse.redirect(new URL(user ? "/refer" : "/signin", request.url));
  if (clean) {
    response.cookies.set(REFERRAL_COOKIE, clean, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 30 * 24 * 3600,
    });
  }
  return response;
}
