import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { TeamInvitations } from "@/components/onboarding-v2/team-invitations";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { onboardingV2Enabled } from "@/server/onboarding-v2/roles";
import { listMyTeamInvitations, myPayoutReadiness } from "@/server/onboarding-v2/team";

export const metadata = { title: "Team invitations" };
export const dynamic = "force-dynamic";

/** A customer's team requests (docs/onboarding-v2-2026-11, Flow 4): accept or decline; the role is added on accept. */
export default async function TeamInvitationsPage() {
  // Sign-in first, then the flag: a guest is always sent to sign-in (guest QA).
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/team/invitations");
  if (!(await onboardingV2Enabled())) notFound();
  const [{ invitations, missing }, payout] = await Promise.all([listMyTeamInvitations(user), myPayoutReadiness(user.id)]);
  return (
    <div className="mx-auto max-w-xl space-y-4 px-4 py-6">
      <PageHeader title="Team invitations" description="Requests from GoKesari dealers to join their team · times in IST" />
      {payout ? (
        <Alert tone="info" title="Complete before your first payout">
          Your team role with {payout.dealerName} is active. Before the first commission payout add: {payout.missing.join(", ")}.{" "}
          <Link className="font-semibold underline" href="/dealer#payment-details">Add them on your dealer page</Link>.
        </Alert>
      ) : null}
      {missing.length && invitations.length ? (
        <Alert tone="warning" title="Complete your account first">
          To accept, your account needs {missing.join(" and ")}. <Link className="font-semibold underline" href="/profile">Open your profile</Link>.
        </Alert>
      ) : null}
      <TeamInvitations invitations={invitations} />
    </div>
  );
}
