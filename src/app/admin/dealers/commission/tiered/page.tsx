import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { TieredAdmin } from "@/components/dealer/tiered-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { dealers } from "@/server/db/schema";
import { earningsByType, listTeamRequests, mappingHistory, teamMapping, teamTree, tierRule, tradingProgress } from "@/server/dealers/tiered";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "TIERED dealer commission" };
export const dynamic = "force-dynamic";

/** Admin → Dealers → Commission → TIERED (docs/dealer-programme/TIERED_COMMISSION.md): admin changes; operators read. */
export default async function TieredCommissionPage({ searchParams }: { searchParams: Promise<{ dealerId?: string }> }) {
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") redirect("/");
  const { dealerId: raw } = await searchParams;
  const dealerId = typeof raw === "string" && /^[0-9a-f-]{36}$/.test(raw) ? raw : null;
  const [rule, tds, requests, list] = await Promise.all([
    tierRule(),
    getRule("dealerPayoutTds"),
    listTeamRequests(),
    // Only what the screen needs: the dealer row also carries encrypted PAN and bank details.
    db
      .select({ id: dealers.id, legalName: dealers.legalName, commissionModel: dealers.commissionModel, tierDirectBp: dealers.tierDirectBp, tierLeadOverrideBp: dealers.tierLeadOverrideBp, tierMainOverrideBp: dealers.tierMainOverrideBp })
      .from(dealers)
      .where(eq(dealers.status, "APPROVED"))
      .orderBy(dealers.legalName),
  ]);
  const selected = list.find((d) => d.id === dealerId) ?? null;
  const [tree, earnings, trading, mapping, history] = selected
    ? await Promise.all([teamTree(selected.id), earningsByType(selected.id), tradingProgress(selected.id), teamMapping(selected.id), mappingHistory(selected.id)])
    : [null, [], [], [], []];
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <Link href="/admin/dealers/commission" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Dealer commission
      </Link>
      <PageHeader
        title="TIERED commission"
        description="The 3-level network model (main dealer → team lead → agent): settings, each dealer's model and rates, the team tree, promotions, sub-agent requests, target bonuses and TDS. Only an admin changes them; every change needs a reason and is logged."
      />
      <TieredAdmin
        isAdmin={user.role === "ADMIN"}
        rule={rule}
        tds={tds}
        dealers={list}
        selected={selected}
        tree={plain(tree)}
        earnings={earnings}
        trading={plain(trading)}
        requests={plain(requests)}
        mapping={plain(mapping)}
        history={plain(history)}
      />
    </div>
  );
}
