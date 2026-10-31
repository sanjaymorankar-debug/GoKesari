/**
 * Gig worker flow: DigiLocker sends the partner back here, consent given or
 * not. Under /mobile-auth/ — the browser half of the app's in-app-browser
 * flows, never an App Link / Universal Link — so a phone never hands this
 * redirect to the app's WebView instead of closing the in-app browser. Opened in whatever browser ran DigiLocker — the app's in-app browser is
 * never signed in — so the random `k` in the link (stored on the check) finds
 * the check; nothing about the partner is shown. The session is settled now
 * (the webhook may also arrive; either is a no-op after the other), then:
 *  - started from the app: hand back to `<scheme>://digilocker-return`, which
 *    closes the in-app browser; the app reloads the KYC page;
 *  - a browser: the KYC page, which shows the result.
 */
import { NextResponse, type NextRequest } from "next/server";

import { DIGILOCKER_APP_CALLBACK_HOST, handleDigilockerReturn } from "@/server/services/rider-kyc";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const key = request.nextUrl.searchParams.get("k") ?? "";
  const { status, app } = await handleDigilockerReturn(key);
  const result = (status ?? "unknown").toLowerCase();
  const target = app
    ? `${app}://${DIGILOCKER_APP_CALLBACK_HOST}?result=${result}`
    : new URL(`/delivery-partner/kyc?digilocker=${result}`, request.nextUrl.origin).toString();
  return NextResponse.redirect(target, 303);
}
