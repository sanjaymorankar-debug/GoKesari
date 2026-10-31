import { headers } from "next/headers";
import { AuthError } from "next-auth";
import { isRedirectError } from "next/dist/client/components/redirect-error";

import { OtpLoginForm } from "@/components/otp-login-form";
import { ConsentSubmitButton, SignInConsentCheckbox, SignInConsentProvider } from "@/components/signin-consent";
import { Card } from "@/components/ui";
import { getEnv } from "@/lib/env";
import { toClientError } from "@/lib/errors";
import { OTP_TICKET_PROVIDER_ID, signIn } from "@/server/auth";
import { emailMode } from "@/server/email/transport";
import { createLoginTicket, verifyLoginOtp } from "@/server/otp/service";
import { signInFromForm } from "@/server/signin-form";

/**
 * Every sign-in lands on /onboarding first, which asks a new account for its details and then
 * returns to the page the person was on — this registration (src/proxy.ts remembers it).
 */
const AFTER_SIGN_IN = "/onboarding";

/**
 * Shop registration (0120, FLOW_2026-10-30.md), before anything else: the owner signs in here,
 * on the registration page itself. SMS codes are not set up yet, so the code always goes by
 * email: a mobile number already on an account gets its code at that account's email, and a new
 * number is asked for an email to send it to (src/server/otp/service.ts). A signed-in customer
 * skips this and registers the shop on the same account.
 */
export function ShopSignInCard() {
  const env = getEnv();
  const googleEnabled = Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);
  const codesAvailable = emailMode() !== "disabled";
  const devLogin = env.NODE_ENV !== "production";

  async function verifyLoginCode(input: { mobile: string | null; email: string | null; code: string; acceptedTerms: boolean }) {
    "use server";
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    let ticket: string;
    try {
      const { user } = await verifyLoginOtp({
        mobile: input?.mobile ?? null,
        email: input?.email ?? null,
        code: String(input?.code ?? ""),
        acceptedTerms: input?.acceptedTerms === true,
        ip,
      });
      ticket = createLoginTicket(user.id);
    } catch (error) {
      return { error: toClientError(error).body.error.message };
    }
    try {
      await signIn(OTP_TICKET_PROVIDER_ID, { ticket, redirectTo: AFTER_SIGN_IN });
    } catch (error) {
      if (isRedirectError(error)) throw error;
      if (error instanceof AuthError) return { error: "Could not sign you in. Please request a new code." };
      throw error;
    }
  }

  return (
    <Card className="rounded-2xl p-4 sm:p-6" data-testid="shop-register-sign-in">
      <SignInConsentProvider>
        <ol className="mb-4 flex items-center gap-2 text-xs font-semibold text-ink-500" aria-label="Before you start">
          <li className="rounded-full bg-kesari-600 px-2.5 py-1 text-white">Sign in</li>
          <li aria-hidden>→</li>
          <li>Referral code</li>
          <li aria-hidden>→</li>
          <li>Documents</li>
          <li aria-hidden>→</li>
          <li>Pay &amp; go live</li>
        </ol>
        <h2 className="text-lg font-semibold text-ink-900">Sign in to register your shop</h2>
        <p className="mt-1 text-sm text-ink-600">
          Already shop on GoKesari? Sign in with the same account — your shop is added to it. New here? Enter your mobile number or email and we&apos;ll create
          your account.
        </p>
        <p className="mt-3 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
          📧 We send your one-time code <strong>by email</strong>. With a mobile number, we ask for your email to send the code to.
        </p>

        <SignInConsentCheckbox className="mt-4" />

        {googleEnabled ? (
          <form
            className="mt-4"
            action={async () => {
              "use server";
              await signInFromForm(() => signIn("google", { redirectTo: AFTER_SIGN_IN }));
            }}
          >
            <ConsentSubmitButton className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-cream-200 bg-white px-4 py-2.5 text-sm font-medium text-ink-700 hover:bg-cream-100 disabled:cursor-not-allowed disabled:opacity-50">
              Continue with Google
            </ConsentSubmitButton>
          </form>
        ) : null}

        {codesAvailable ? (
          <OtpLoginForm verify={verifyLoginCode} />
        ) : (
          <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Sign-in codes cannot be emailed right now. Please try again later.
          </p>
        )}

        {devLogin ? (
          <form
            className="mt-6 border-t border-cream-200 pt-4"
            action={async (formData: FormData) => {
              "use server";
              await signInFromForm(() => signIn("test-credentials", { email: String(formData.get("email") ?? ""), redirectTo: AFTER_SIGN_IN }));
            }}
          >
            <label className="mb-1 block text-sm font-medium text-ink-700">Development sign-in</label>
            <div className="flex gap-2">
              <input
                type="email"
                name="email"
                required
                placeholder="you@example.com"
                className="min-w-0 flex-1 rounded-lg border border-cream-200 px-3 py-2 text-sm focus:border-kesari-500 focus:outline-none"
              />
              <button type="submit" className="rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800">
                Continue
              </button>
            </div>
            <p className="mt-2 text-xs text-ink-500">Local development only — disabled in production builds.</p>
          </form>
        ) : null}
      </SignInConsentProvider>
    </Card>
  );
}
