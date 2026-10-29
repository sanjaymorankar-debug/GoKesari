import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { CommissionAdmin } from "@/components/dealer/commission-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getCommissionSettings, listCommissionRules, listLedger, listPayouts, listRatingSlabs } from "@/server/dealers/commission";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { listDistricts, listStates } from "@/server/services/geo-areas";

export const metadata = { title: "Dealer commission" };
export const dynamic = "force-dynamic";

/** Dealer commission (docs/dealer-programme, GKS-CM-001…003): admin changes; operators read. Not there while the programme is off. */
export default async function DealerCommissionPage() {
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") redirect("/");
  const [rules, settings, slabs, ledger, payouts, districts, states] = await Promise.all([
    listCommissionRules({ all: true }),
    getCommissionSettings(),
    listRatingSlabs(),
    listLedger(),
    listPayouts(),
    listDistricts(),
    listStates(),
  ]);
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <Link href="/admin/dealers" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Dealers
      </Link>
      <PageHeader title="Dealer commission" description="The base commission % and how the rating moves it, the per-shop cap, rating slabs, and the ledger from earned to paid. Only an admin changes them; every change needs a reason and is logged." />
      <CommissionAdmin
        isAdmin={user.role === "ADMIN"}
        rules={plain(rules)}
        settings={plain(settings)}
        slabs={plain(slabs)}
        ledger={plain(ledger)}
        payouts={plain(payouts)}
        // A rule may cover a whole state or one district.
        districts={[...states.map((s) => ({ code: s.code, name: `${s.name} (whole state)` })), ...districts.map((d) => ({ code: d.code, name: `${d.name} (${d.code.split("-")[0]})` }))]}
      />
    </div>
  );
}
