import { notFound, redirect } from "next/navigation";

import { MyTeam } from "@/components/onboarding-v2/my-team";
import { Alert, LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { onboardingV2Enabled } from "@/server/onboarding-v2/roles";
import { teamOverview } from "@/server/onboarding-v2/team";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "My team" };
export const dynamic = "force-dynamic";

/**
 * Onboarding v2 "My team" (docs/onboarding-v2-2026-11, Flow 4) for a dealer, a franchise owner (also a dealer)
 * and a team lead adding agents under himself. Not there while onboarding_v2 or the dealer programme is off — the
 * dealer page's existing team section is unchanged.
 */
export default async function MyTeamPage() {
  if (!(await onboardingV2Enabled()) || !(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/dealer/team");
  const data = await teamOverview(user).catch((e: unknown) => (e instanceof Error ? e.message : "Not available."));
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <PageHeader
        title="My team"
        description={typeof data === "string" ? "GoKesari dealer team" : `${data.dealer.name} · all times IST`}
        action={<LinkButton href="/dealer" variant="secondary">Dealer page</LinkButton>}
      />
      {typeof data === "string" ? <Alert tone="warning">{data}</Alert> : <MyTeam data={JSON.parse(JSON.stringify(data))} />}
    </div>
  );
}
