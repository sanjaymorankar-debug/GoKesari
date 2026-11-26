import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { onboardingV2Enabled } from "@/server/onboarding-v2/roles";
import { claimTeamInvitation } from "@/server/onboarding-v2/team";

export const metadata = { title: "Join a team" };
export const dynamic = "force-dynamic";

/**
 * A team invite link (docs/onboarding-v2-2026-11, Flow 4). Signed out: sign in or create the free customer
 * account, which brings the person back here; signed in: the invitation is tied to the account and they land on
 * /team/invitations to accept or decline.
 */
export default async function JoinTeamPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const here = `/team/join/${encodeURIComponent(token)}`;
  // Sign-in first, then the flag: a guest is always sent to sign-in (guest QA).
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=${encodeURIComponent(here)}`);
  if (!(await onboardingV2Enabled())) notFound();
  const result = await claimTeamInvitation(user, token).catch((e: unknown) => (e instanceof Error ? e.message : "This invitation cannot be used."));
  if (typeof result !== "string") redirect("/team/invitations");
  return (
    <div className="mx-auto max-w-xl space-y-4 px-4 py-6">
      <PageHeader title="Join a team" />
      <Alert tone="warning">{result}</Alert>
      <p className="text-sm">
        <Link className="underline" href="/team/invitations">See your team invitations</Link>
      </p>
    </div>
  );
}
