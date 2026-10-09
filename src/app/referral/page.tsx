import { and, desc, eq, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { CustomerReferralRequestForm, EnterSignupReferralCode, MyCustomerReferralRequests } from "@/components/customer-referral-code";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { REFERRAL_COOKIE } from "@/lib/customer-referrals";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { addresses } from "@/server/db/schema";
import { listMyCustomerReferralRequests } from "@/server/services/customer-referral-requests";
import { getSignupReferral, needsSignupReferralCode, shouldAskSignupReferral } from "@/server/services/customer-signup-referrals";
import { getProfile } from "@/server/services/profile";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "My referral code" };
export const dynamic = "force-dynamic";

/**
 * My referral code (docs/four-features-2026-10, the owner's decision of 9 Oct
 * 2026; rule customerSignupReferral). Enter the code you were given — or ask
 * GoKesari for one with your location, contact number, city and PIN code.
 */
export default async function MyReferralCodePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const [rule, friendRule] = await Promise.all([getRule("customerSignupReferral"), getRule("customerReferrals")]);
  const invite = friendRule.enabled ? (
    <p className="text-sm text-ink-600">
      Want to invite others?{" "}
      <Link href="/refer" className="font-medium text-kesari-700 hover:underline">
        Get your own invite code
      </Link>
      .
    </p>
  ) : null;
  if (!rule.enabled) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <PageHeader title="My referral code" />
        <EmptyState title="Referral codes aren't asked for right now." />
        {invite}
      </div>
    );
  }

  const [referral, ask, needsCode, requests, profile, jar] = await Promise.all([
    getSignupReferral(user.id),
    shouldAskSignupReferral(user.id),
    needsSignupReferralCode(user.id),
    listMyCustomerReferralRequests(user.id),
    getProfile(user.id),
    cookies(),
  ]);
  const [address] = await db
    .select({ city: addresses.city, pincode: addresses.pincode })
    .from(addresses)
    .where(and(eq(addresses.userId, user.id), isNull(addresses.deletedAt)))
    .orderBy(desc(addresses.isDefault), desc(addresses.createdAt))
    .limit(1);
  const waiting = requests.some((r) => r.status === "NEW");

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title="My referral code"
        description={needsCode ? "A referral code is needed before your first order. Browse and search all you like in the meantime." : undefined}
      />
      {referral ? (
        <div data-testid="signup-referral-given">
          <Alert tone="success" title="You're all set">
            You joined with the referral code {referral.code}
            {referral.label ? ` (${referral.label})` : ""}.
          </Alert>
        </div>
      ) : ask ? (
        <>
          <EnterSignupReferralCode initialCode={jar.get(REFERRAL_COOKIE)?.value ?? ""} required={needsCode} />
          <MyCustomerReferralRequests requests={requests} canUse />
          {waiting ? (
            <Alert tone="info">We have your request — our team will contact you with your referral code. There is no need to ask again.</Alert>
          ) : (
            <CustomerReferralRequestForm
              prefill={{
                name: profile.name ?? "",
                mobile: profile.phoneE164?.startsWith("+91") ? profile.phoneE164.slice(3) : "",
                city: address?.city ?? "",
                pincode: address?.pincode ?? "",
              }}
            />
          )}
        </>
      ) : (
        <Alert tone="info">A referral code is only asked for when you join, before your first order — there is nothing to do here.</Alert>
      )}
      {invite}
    </div>
  );
}
