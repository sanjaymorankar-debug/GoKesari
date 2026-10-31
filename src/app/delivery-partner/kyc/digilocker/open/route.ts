/**
 * Gig worker flow: the "resend link" notification opens this — the partner's
 * own open DigiLocker link (signed in), or the KYC page when there is none.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/server/authz/guards";
import { myOpenDigilockerUrl } from "@/server/services/rider-kyc";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/signin", request.nextUrl.origin), 303);
  const url = await myOpenDigilockerUrl(user.id).catch(() => null);
  return NextResponse.redirect(url ?? new URL("/delivery-partner/kyc", request.nextUrl.origin).toString(), 303);
}
