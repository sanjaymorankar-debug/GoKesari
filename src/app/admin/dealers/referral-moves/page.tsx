import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ReferralMovesAdmin } from "@/components/dealer/referral-moves-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listMoveRequests, moveTargets } from "@/server/dealers/referral-moves";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Referral moves" };
export const dynamic = "force-dynamic";

/** Admin → Dealers → Referral moves (owner, 22-Nov-2026): add / move a referral code with consent letters and a second admin's approval. */
export default async function ReferralMovesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN") redirect("/");
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const [requests, targets] = await Promise.all([listMoveRequests(), moveTargets()]);
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <Link href="/admin/dealers" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Dealers
      </Link>
      <PageHeader
        title="Referral moves"
        description="Add a referral code to a shop, move shops to another franchise / team member's code, or move a team member with his code and his shops to another franchise team. Upload the signed consent letters; a different admin approves. Commission earned before the move stays where it was earned; from the move the new team earns."
      />
      <ReferralMovesAdmin userId={user.id} requests={JSON.parse(JSON.stringify(requests))} targets={targets} />
    </div>
  );
}
