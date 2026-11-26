import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { SmsSecondFactor } from "@/components/sms-second-factor";
import { Card } from "@/components/ui";
import { toClientError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { pendingGoogleChallenge } from "@/server/otp/google-second-factor";
import { resumeSecondFactor, type SecondFactorPrompt } from "@/server/otp/second-factor";

export const metadata = { title: "Confirm sign-in" };
export const dynamic = "force-dynamic";

/**
 * docs/sms-2fa-2026-11: Google (or an emailed link) was verified, but the
 * account also needs a code by SMS. The challenge is in an httpOnly cookie set
 * by Auth.js's signIn callback (src/server/otp/google-second-factor.ts).
 */
export default async function SecondFactorPage() {
  if (await getCurrentUser()) redirect("/");
  const challenge = await pendingGoogleChallenge();
  let prompt: SecondFactorPrompt | null = null;
  let problem: string | null = null;
  if (challenge) {
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    try {
      prompt = await resumeSecondFactor(challenge, ip);
    } catch (error) {
      problem = toClientError(error).body.error.message;
    }
  }

  return (
    <div className="mx-auto max-w-md py-8">
      <Card className="p-8">
        <h1 className="text-2xl font-semibold text-ink-900">Confirm it&apos;s you</h1>
        {prompt ? (
          <div className="mt-4">
            <SmsSecondFactor prompt={prompt} />
          </div>
        ) : (
          <p role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="second-factor-expired">
            {problem ?? "This sign-in has expired."}{" "}
            <Link href="/signin" className="underline">
              Sign in again
            </Link>
            .
          </p>
        )}
      </Card>
    </div>
  );
}
