import { AuthError } from "next-auth";
import { isRedirectError } from "next/dist/client/components/redirect-error";

import { MobileAuthFinisher } from "@/components/mobile-auth-finisher";
import { Card } from "@/components/ui";
import { OTP_TICKET_PROVIDER_ID, signIn } from "@/server/auth";
import { redeemMobileAuthCode } from "@/server/mobile-auth";
import { createLoginTicket } from "@/server/otp/service";

export const metadata = { title: "Signing in" };
export const dynamic = "force-dynamic";

/** Same landing as every other sign-in method (see /signin). */
const AFTER_SIGN_IN = "/onboarding";

/**
 * Step 3 of the app's Google sign-in (src/server/mobile-auth.ts), inside the
 * app's WebView: trade the code from the browser, plus the verifier only this
 * app holds, for a session — through the same login ticket the sign-in code
 * flow uses, so a suspended or closed account is refused here too.
 */
export default function MobileAuthFinishPage() {
  async function finish(input: { code: string; verifier: string }) {
    "use server";
    const userId = redeemMobileAuthCode(String(input?.code ?? ""), String(input?.verifier ?? ""));
    if (!userId) return { error: "This sign-in has expired. Please tap Continue with Google again." };
    try {
      await signIn(OTP_TICKET_PROVIDER_ID, { ticket: createLoginTicket(userId), redirectTo: AFTER_SIGN_IN });
    } catch (error) {
      if (isRedirectError(error)) throw error;
      if (error instanceof AuthError) return { error: "Could not sign you in. Please try again." };
      throw error;
    }
  }

  return (
    <div className="mx-auto max-w-md py-8">
      <Card className="p-8">
        <h1 className="text-2xl font-semibold text-ink-900">Signing in</h1>
        <MobileAuthFinisher finish={finish} />
      </Card>
    </div>
  );
}
