/**
 * DigiLocker sends the person back here, consent given or not — for both
 * flows that use DigiLocker: delivery partner KYC (gig worker flow) and the
 * customer / shop owner identity check (docs/identity-verification-2026-11).
 * Under /mobile-auth/ — the browser half of the app's in-app-browser flows,
 * never an App Link / Universal Link — so a phone never hands this redirect to
 * the app's WebView instead of closing the in-app browser. Opened in whatever
 * browser ran DigiLocker — the app's in-app browser is never signed in — so
 * the random `k` in the link (stored on the row) finds the rider check or the
 * identity attempt; nothing about the person is shown. The session is settled
 * now (the webhook may also arrive; either is a no-op after the other), then:
 *  - started from the app: hand back to `<scheme>://digilocker-return?result=
 *    verified|pending|failed`, which closes the in-app browser; the app's page
 *    re-checks (mobile/src/digilocker.ts — the same for both flows);
 *  - a browser: the flow's own page, which shows the result.
 */
import { NextResponse, type NextRequest } from "next/server";

import { VERIFY_IDENTITY_PATH } from "@/lib/kyc/identity";
import { DIGILOCKER_APP_CALLBACK_HOST, siteBase } from "@/server/kyc/digilocker-session";
import { handleIdentityDigilockerReturn, identityReturnResult } from "@/server/services/identity-verification";
import { handleDigilockerReturn } from "@/server/services/rider-kyc";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const key = request.nextUrl.searchParams.get("k") ?? "";
  const rider = await handleDigilockerReturn(key);
  if (rider.status) {
    const result = rider.status.toLowerCase();
    const target = rider.app
      ? `${rider.app}://${DIGILOCKER_APP_CALLBACK_HOST}?result=${result}`
      : `${siteBase()}/delivery-partner/kyc?digilocker=${result}`;
    return NextResponse.redirect(target, 303);
  }
  const identity = await handleIdentityDigilockerReturn(key);
  if (identity.status) {
    const result = identityReturnResult(identity.status);
    const target = identity.app
      ? `${identity.app}://${DIGILOCKER_APP_CALLBACK_HOST}?result=${result}`
      : `${siteBase()}${VERIFY_IDENTITY_PATH}?digilocker=${result}`;
    return NextResponse.redirect(target, 303);
  }
  // Unknown key: the rider page, as before.
  return NextResponse.redirect(`${siteBase()}/delivery-partner/kyc?digilocker=unknown`, 303);
}
