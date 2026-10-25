import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { MobilePromptDialog, ProfileSetupWizard, type GenderValue } from "@/components/profile-setup";
import { REFERRAL_COOKIE } from "@/lib/customer-referrals";
import { RETURN_TO_COOKIE, safeReturnPath } from "@/lib/return-to";
import { getCurrentUser } from "@/server/authz/guards";
import { needsSignupReferralCode, shouldAskSignupReferral } from "@/server/services/customer-signup-referrals";
import { getProfile, nextOnboardingStep } from "@/server/services/profile";

export const metadata = { title: "Welcome" };
export const dynamic = "force-dynamic";

/**
 * Every sign-in lands here. It asks for the first-time details until they are
 * saved once, then — while there is no mobile number — shows the "add your
 * mobile" popup. Otherwise it goes straight on: to the page the person was
 * on within the last 24 hours (D-23, src/proxy.ts), else the home page.
 */
export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const profile = await getProfile(user.id);
  const step = nextOnboardingStep(profile);
  const returnTo = safeReturnPath((await cookies()).get(RETURN_TO_COOKIE)?.value) ?? "/";
  if (step === "DONE") redirect(returnTo);

  if (step === "MOBILE") {
    return (
      <div className="mx-auto max-w-2xl py-8">
        <MobilePromptDialog returnTo={returnTo} />
      </div>
    );
  }

  // Referral code at registration (docs/four-features-2026-10, rule customerSignupReferral).
  const askReferral = await shouldAskSignupReferral(user.id);
  const prefill = askReferral ? ((await cookies()).get(REFERRAL_COOKIE)?.value ?? "") : "";
  const requireReferral = askReferral && (await needsSignupReferralCode(user.id));

  return (
    <div className="mx-auto max-w-2xl py-8">
      <ProfileSetupWizard
        returnTo={returnTo}
        referral={askReferral ? { prefill, required: requireReferral } : null}
        initial={{
          name: profile.name ?? "",
          gender: (profile.gender ?? "") as GenderValue | "",
          mobile: profile.phoneE164?.startsWith("+91") ? profile.phoneE164.slice(3) : "",
          email: profile.email,
        }}
        hasDefaultAddress={profile.hasDefaultAddress}
      />
    </div>
  );
}
