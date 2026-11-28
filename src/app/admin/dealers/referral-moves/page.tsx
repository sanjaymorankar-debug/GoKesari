import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ReferralMovesAdmin } from "@/components/dealer/referral-moves-admin";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listMoveRequests, moveTargets, referralMoveSettings } from "@/server/dealers/referral-moves";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Referral moves" };
export const dynamic = "force-dynamic";

/** Admin → Dealers → Referral moves (owner, 22-Nov-2026): add / move a referral code with consent letters and a second admin's approval. */
export default async function ReferralMovesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN") redirect("/");
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const [requests, targets, settings] = await Promise.all([listMoveRequests(), moveTargets(), referralMoveSettings()]);
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <Link href="/admin/dealers" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Dealers
      </Link>
      <PageHeader
        title="Referral moves"
        description="Add a referral code to a shop, move shops to another franchise / team member's code, or move a team member with his code and his shops to another franchise team. Upload the signed consent letters (unless the rule makes them optional); a different admin approves. Commission earned before the move stays where it was earned; from the move the new team earns."
      />
      {/* Owner, 28-Nov-2026: rule referralMoves — on / off, and whether consent letters are required. */}
      {!settings.enabled ? (
        <Alert tone="warning" title="Referral moves are switched off">
          No new request can be raised and none can be approved. An admin switches them on in <Link className="underline" href="/admin/settings?rule=referralMoves">Business rules → referralMoves</Link>.
        </Alert>
      ) : !settings.requireConsents ? (
        <Alert tone="info" title="Consent letters are optional">
          Requests can be approved without the signed letters (rule referralMoves.requireConsents is off). A different admin still approves. <Link className="underline" href="/admin/settings?rule=referralMoves">Change</Link>
        </Alert>
      ) : (
        <p className="mb-3 text-xs text-ink-600">
          Signed consent letters are required (rule referralMoves). <Link className="underline" href="/admin/settings?rule=referralMoves">Switch moves or the letters on / off</Link>
        </p>
      )}
      <ReferralMovesAdmin userId={user.id} requests={JSON.parse(JSON.stringify(requests))} targets={targets} />
    </div>
  );
}
