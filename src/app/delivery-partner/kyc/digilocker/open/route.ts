/**
 * Gig worker flow: the "resend link" notification opens this — the partner's
 * own open DigiLocker link (signed in), or the KYC page when there is none.
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/authz/guards";
import { myOpenDigilockerUrl, siteBase } from "@/server/services/rider-kyc";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(`${siteBase()}/signin`, 303);
  const url = await myOpenDigilockerUrl(user.id).catch(() => null);
  return NextResponse.redirect(url ?? `${siteBase()}/delivery-partner/kyc`, 303);
}
