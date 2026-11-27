import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { isRedirectError } from "next/dist/client/components/redirect-error";

import { DualVerifyPanel } from "@/components/dual-verify/dual-verify-panel";
import { Card } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { signIn } from "@/server/auth";
import { EMAIL_PROVIDER_ID, emailSignInMode } from "@/server/auth-email";
import { dualVerifyStatus } from "@/server/dual-auth/verify";

export const metadata = { title: "Verify your mobile and e-mail" };
export const dynamic = "force-dynamic";

function safeReturn(value: string | string[] | undefined): string {
  const v = typeof value === "string" ? value : "";
  return v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/account/verify") ? v : "/";
}

/**
 * docs/dual-auth-2026-11 — the DualVerify page. A signed-in account with one verified factor (or none) verifies the
 * missing one here: mobile by an SMS code, e-mail by a code (or the e-mailed sign-in link). Browsing never needs
 * it; orders, shop / dealer / admin work and withdrawals send people here, then back to `?return=`.
 */
export default async function DualVerifyPage({ searchParams }: { searchParams: Promise<{ return?: string | string[] }> }) {
  const returnTo = safeReturn((await searchParams).return);
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=${encodeURIComponent(`/account/verify?return=${encodeURIComponent(returnTo)}`)}`);
  const status = await dualVerifyStatus(user.id);
  const linkAvailable = emailSignInMode() !== "disabled" && !status.placeholderEmail && !status.emailVerified;

  async function emailLink(): Promise<{ error?: string; sent?: boolean }> {
    "use server";
    const me = await getCurrentUser();
    if (!me) return { error: "Please sign in again." };
    try {
      // Opening the link signs this same account in again and marks its e-mail verified (Auth.js).
      await signIn(EMAIL_PROVIDER_ID, { email: me.email, redirectTo: `/account/verify?return=${encodeURIComponent(returnTo)}`, redirect: false });
    } catch (error) {
      if (isRedirectError(error)) throw error;
      if (error instanceof AuthError) return { error: "We could not send the link. Use the e-mail code instead." };
      throw error;
    }
    return { sent: true };
  }

  return (
    <div className="mx-auto max-w-md py-6">
      <Card className="p-6">
        <h1 className="text-2xl font-semibold text-ink-900">Verify your mobile and e-mail</h1>
        <p className="mt-2 text-sm text-ink-600">
          GoKesari accounts need both a verified mobile number and a verified e-mail. You can keep browsing; ordering, shop and dealer
          work and withdrawals need both.
        </p>
        <div className="mt-5">
          {status.inForce || status.canVerify || status.missing.length === 0 ? (
            <DualVerifyPanel initial={status} returnTo={returnTo} linkAction={linkAvailable ? emailLink : undefined} />
          ) : (
            <p className="text-sm text-ink-600" data-testid="dual-verify-not-in-force">
              Verification codes cannot be sent on this site right now. Nothing more is needed from you for now.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
