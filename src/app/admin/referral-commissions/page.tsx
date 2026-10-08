import { redirect } from "next/navigation";

import { CommissionStatus } from "@/components/registration/admin-actions";
import { Card, PageHeader } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { commissionReport } from "@/server/registration/admin";

export const metadata = { title: "Distributor commission" };
export const dynamic = "force-dynamic";

/** Module 3: commission recorded per self-registered shop, by distributor. Nothing is paid out by the system. */
export default async function CommissionsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.REFERRAL_MANAGE)) redirect("/");
  const { byDistributor, rows } = await commissionReport();
  const canChange = can(user.role, PERMISSIONS.REGISTRATION_FEE_MANAGE);
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="Distributor commission" description="Recorded when a shop registered with a distributor's code is approved. Mark it approved and paid as you settle with distributors outside GoKesari." />
      <Card className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-cream-100 text-left text-xs text-ink-500"><tr><th className="px-3 py-2">Distributor</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Shops</th><th className="px-3 py-2">Fees</th><th className="px-3 py-2">Commission</th></tr></thead>
          <tbody className="divide-y divide-cream-200">
            {byDistributor.map((r) => (
              <tr key={`${r.distributorId}-${r.status}`}><td className="px-3 py-2">{r.name ?? "–"}</td><td className="px-3 py-2">{r.status.toLowerCase()}</td><td className="px-3 py-2">{r.shops}</td><td className="px-3 py-2">{formatPaise(r.feesPaise)}</td><td className="px-3 py-2 font-medium">{formatPaise(r.amountPaise)}</td></tr>
            ))}
            {byDistributor.length === 0 ? <tr><td colSpan={5} className="px-3 py-6 text-center text-ink-500">No commission yet.</td></tr> : null}
          </tbody>
        </table>
      </Card>
      <Card className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-cream-100 text-left text-xs text-ink-500"><tr><th className="px-3 py-2">Shop</th><th className="px-3 py-2">Code · distributor</th><th className="px-3 py-2">Fee</th><th className="px-3 py-2">Rate</th><th className="px-3 py-2">Commission</th><th className="px-3 py-2">Status</th></tr></thead>
          <tbody className="divide-y divide-cream-200">
            {rows.map((r) => (
              <tr key={r.commission.id}>
                <td className="px-3 py-2">{r.shopName}<span className="block text-xs text-ink-500">{r.registrationNumber}</span></td>
                <td className="px-3 py-2">{r.code}<span className="block text-xs text-ink-500">{r.distributorName ?? "–"}</span></td>
                <td className="px-3 py-2">{formatPaise(Number(r.commission.basePaise))}</td>
                <td className="px-3 py-2 text-xs">{r.commission.commissionType === "FLAT" ? `flat ${formatPaise(r.commission.commissionValue)}` : `${r.commission.commissionValue / 100}%`}</td>
                <td className="px-3 py-2 font-medium">{formatPaise(Number(r.commission.amountPaise))}</td>
                <td className="px-3 py-2"><CommissionStatus id={r.commission.id} status={r.commission.status} canChange={canChange} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
