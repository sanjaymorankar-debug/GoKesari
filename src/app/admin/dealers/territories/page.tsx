import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { TerritoryAdmin } from "@/components/dealer/territory-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { territoryCandidates, territoryRule, territoryViews } from "@/server/dealers/territory";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Territory dealers" };
export const dynamic = "force-dynamic";

/** Admin → Dealers → Territories (docs/dealer-programme/TERRITORY_DEALER.md): admin changes; operators read. */
export default async function TerritoryDealersPage() {
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") redirect("/");
  const [rule, territories, dealers] = await Promise.all([territoryRule(), territoryViews(null), territoryCandidates()]);
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <Link href="/admin/dealers" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Dealers
      </Link>
      <PageHeader
        title="Territory dealers"
        description="Exclusive territories (pincodes) a TIERED dealer holds for a yearly fee. He keeps his team's registration commission and also earns a share of GoKesari's commission on every order delivered in his territory: 20% at rating 5, up to 25% at rating 10. Only an admin changes them; every change is logged."
      />
      <TerritoryAdmin isAdmin={user.role === "ADMIN"} rule={rule} territories={JSON.parse(JSON.stringify(territories))} dealers={dealers} />
    </div>
  );
}
