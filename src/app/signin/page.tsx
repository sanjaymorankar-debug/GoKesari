import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { isRedirectError } from "next/dist/client/components/redirect-error";

import { OtpLoginForm } from "@/components/otp-login-form";
import { Card } from "@/components/ui";
import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/server/authz/guards";
import { OTP_TICKET_PROVIDER_ID, signIn } from "@/server/auth";
import { EMAIL_PROVIDER_ID, emailSignInMode } from "@/server/auth-email";
import { emailMode } from "@/server/email/transport";
import { isTextChannelAvailable } from "@/server/messaging/sms-whatsapp";
import { createLoginTicket, verifyLoginOtp } from "@/server/otp/service";
import { toClientError } from "@/lib/errors";
import { headers } from "next/headers";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

/** Every sign-in method lands here first: it asks for missing details, then goes home. */
const AFTER_SIGN_IN = "/onboarding";

/**
 * Production sign-in methods: Google (§5) and, when an SMTP sender is
 * configured, an emailed one-time link (GS-001). A dev-only email form is
 * rendered outside production so the app is usable locally and in end-to-end
 * tests; it is never available in production.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ "check-email"?: string; error?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect("/");

  const env = getEnv();
  const googleEnabled = Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);
  const emailEnabled = emailSignInMode(env) !== "disabled";
  const query = await searchParams;
  const checkEmail = Boolean(query["check-email"]);
  // Auth.js sends AccessDenied when the signIn callback refuses: a suspended or closed account.
  const accessDenied = query.error === "AccessDenied";
  const devLoginEnabled = env.NODE_ENV !== "production";
  // Module 3: with SMS set up, shops registered with a mobile number alone sign in by SMS code.
  const otpEmailAvailable = emailMode() !== "disabled" || isTextChannelAvailable("SMS");

  async function verifyLoginCode(input: { mobile: string | null; email: string | null; code: string }) {
    "use server";
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    let ticket: string;
    try {
      const { user } = await verifyLoginOtp({ ...input, ip });
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
    <div className="mx-auto max-w-md py-8">
      <Card className="p-8">
        <h1 className="text-2xl font-semibold text-ink-900">Sign in</h1>
        <p className="mt-1 text-sm text-ink-500">
          A wallet is created for you automatically on first sign-in.
        </p>

        {accessDenied ? (
          <p
            role="alert"
            className="mt-6 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
            data-testid="signin-access-denied"
          >
            This account is suspended or closed, so it cannot sign in. If you think this is a mistake,{" "}
            <a href="/grievance" className="underline">
              contact us through the grievance form
            </a>
            .
          </p>
        ) : null}

        {googleEnabled ? (
          <form
            className="mt-6"
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: AFTER_SIGN_IN });
            }}
          >
            <label className="mb-3 flex items-start gap-2 text-xs text-ink-600">
              <input type="checkbox" required className="mt-0.5" />
              <span>
                I agree to the{" "}
                <a href="/legal/terms" target="_blank" className="underline">
                  Terms &amp; Conditions
                </a>{" "}
                and{" "}
                <a href="/legal/privacy-policy" target="_blank" className="underline">
                  Privacy Policy
                </a>
                .
              </span>
            </label>
            <button
              type="submit"
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-cream-200 bg-white px-4 py-2.5 text-sm font-medium text-ink-700 hover:bg-cream-100"
            >
              Continue with Google
            </button>
          </form>
        ) : (
          <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Google sign-in is not configured. Set <code>AUTH_GOOGLE_ID</code> and{" "}
            <code>AUTH_GOOGLE_SECRET</code> to enable it.
          </p>
        )}

        {otpEmailAvailable ? (
          <OtpLoginForm verify={verifyLoginCode} />
        ) : (
          <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Sign-in codes cannot be emailed: set <code>AUTH_EMAIL_FROM</code> and <code>AUTH_EMAIL_SERVER</code>.
          </p>
        )}

        {checkEmail ? (
          <p
            className="mt-6 rounded-lg border border-leaf-300 bg-leaf-50 p-3 text-sm text-leaf-700"
            data-testid="check-email"
          >
            Check your email — we sent you a sign-in link. It works once and expires in 15
            minutes.
          </p>
        ) : null}

        {emailEnabled ? (
          <form
            className="mt-6 border-t border-cream-200 pt-6"
            action={async (formData: FormData) => {
              "use server";
              await signIn(EMAIL_PROVIDER_ID, {
                email: String(formData.get("email") ?? ""),
                redirectTo: AFTER_SIGN_IN,
              });
            }}
          >
            <label htmlFor="magic-link-email" className="mb-1 block text-sm font-medium text-ink-700">
              Or get a sign-in link by email
            </label>
            <div className="flex gap-2">
              <input
                id="magic-link-email"
                type="email"
                name="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                className="min-w-0 flex-1 rounded-lg border border-cream-200 px-3 py-2 text-sm focus:border-kesari-500 focus:outline-none"
              />
              <button
                type="submit"
                className="rounded-lg border border-cream-200 bg-white px-4 py-2 text-sm font-medium text-ink-700 hover:bg-cream-100"
              >
                Email me a link
              </button>
            </div>
            <label className="mt-3 flex items-start gap-2 text-xs text-ink-600">
              <input type="checkbox" required className="mt-0.5" />
              <span>
                I agree to the{" "}
                <a href="/legal/terms" target="_blank" className="underline">
                  Terms &amp; Conditions
                </a>{" "}
                and{" "}
                <a href="/legal/privacy-policy" target="_blank" className="underline">
                  Privacy Policy
                </a>
                .
              </span>
            </label>
          </form>
        ) : null}

        {devLoginEnabled ? (
          <form
            className="mt-6 border-t border-cream-200 pt-6"
            action={async (formData: FormData) => {
              "use server";
              await signIn("test-credentials", {
                email: String(formData.get("email") ?? ""),
                redirectTo: AFTER_SIGN_IN,
              });
            }}
          >
            <label className="mb-1 block text-sm font-medium text-ink-700">
              Development sign-in
            </label>
            <div className="flex gap-2">
              <input
                type="email"
                name="email"
                required
                placeholder="you@example.com"
                className="min-w-0 flex-1 rounded-lg border border-cream-200 px-3 py-2 text-sm focus:border-kesari-500 focus:outline-none"
              />
              <button
                type="submit"
                className="rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800"
              >
                Continue
              </button>
            </div>
            <p className="mt-2 text-xs text-ink-500">
              Local development only — disabled in production builds.
            </p>
          </form>
        ) : null}
      </Card>
    </div>
  );
}
