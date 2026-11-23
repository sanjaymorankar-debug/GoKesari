import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Card, PageHeader, inputClass } from "@/components/ui";
import { DEALER_STATUSES } from "@/lib/dealers";
import { getCurrentUser } from "@/server/authz/guards";
import { dashboardFilters } from "@/server/dealers/dashboard-filters";
import { platformDashboard } from "@/server/dealers/platform-dashboard";
import { listSchemes } from "@/server/dealers/schemes";
import { isDealerStaff, regionScope } from "@/server/dealers/staff-access";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Dealer platform dashboard" };
export const dynamic = "force-dynamic";

const rupees = (p: number) => `₹${Math.round(p / 100).toLocaleString("en-IN")}`;

/**
 * docs/dealer-platform phase 6 (brief §12): dealers by scheme and status, registrations by month, shops onboarded
 * and activated, GMV, platform revenue, commission (accrued, monthly, paid, liability), pending settlements,
 * territory utilisation and scheme performance — filtered by date, scheme, dealer, state / district / city,
 * dealer status and shop status. A Regional Admin sees his regions only.
 */
export default async function DealerPlatformDashboard({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/admin/dealers/dashboard");
  if (!isDealerStaff(user.role)) redirect("/");
  const params = await searchParams;
  const f = dashboardFilters(params);
  const actor = { id: user.id, role: user.role };
  const [d, schemes, scope] = await Promise.all([platformDashboard(actor, f), listSchemes(), regionScope(actor)]);
  const query = new URLSearchParams(Object.entries(f).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]));
  const tiles: [string, string][] = [
    ["Dealers", String(d.dealers.total)],
    ["Free / paid / franchise", `${d.dealers.free} / ${d.dealers.paid} / ${d.dealers.franchise}`],
    ["Earning in the last 90 days", String(d.dealers.activeEarning)],
    ["Shops onboarded / activated", `${d.shops.onboarded} / ${d.shops.activated}`],
    ["GMV (sales)", rupees(d.money.gmvPaise)],
    ["Platform revenue", rupees(d.money.platformRevenuePaise)],
    ["Commission accrued", rupees(d.money.commissionAccruedPaise)],
    ["of which monthly (recurring)", rupees(d.money.recurringPaise)],
    ["Commission paid", rupees(d.money.paidPaise)],
    ["Commission liability (unpaid)", rupees(d.money.liabilityPaise)],
    ["Pending settlements", rupees(d.money.pendingSettlementPaise)],
    ["Net revenue before other costs", rupees(d.money.netRevenuePaise)],
    ["Territory utilisation", `${(d.territory.utilisationBp / 100).toFixed(1)}% (${d.territory.occupied}/${d.territory.capacity} slots, ${d.territory.zones} zones)`],
  ];
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <Link href="/admin/dealers" className="inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Dealers
      </Link>
      <PageHeader title="Dealer platform dashboard" description={`Every scheme, dealer, shop and commission in one place${scope ? ` — your regions: ${scope.join(", ") || "none set"}` : ""}.`} />
      <Card className="p-4">
        <form method="get" className="grid gap-2 sm:grid-cols-4" data-testid="dashboard-filters">
          <label className="text-sm">From<input className={inputClass} type="date" name="from" defaultValue={f.from} /></label>
          <label className="text-sm">To<input className={inputClass} type="date" name="to" defaultValue={f.to} /></label>
          <label className="text-sm">Scheme
            <select className={inputClass} name="scheme" defaultValue={f.scheme ?? ""}>
              <option value="">All</option>
              {schemes.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
          </label>
          <label className="text-sm">Dealer status
            <select className={inputClass} name="dealerStatus" defaultValue={f.dealerStatus ?? ""}>
              <option value="">All</option>
              {DEALER_STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
            </select>
          </label>
          <label className="text-sm">State (e.g. MH)<input className={inputClass} name="state" defaultValue={f.state ?? ""} maxLength={2} /></label>
          <label className="text-sm">District (e.g. MH-PUN)<input className={inputClass} name="district" defaultValue={f.district ?? ""} maxLength={20} /></label>
          <label className="text-sm">City<input className={inputClass} name="city" defaultValue={f.city ?? ""} maxLength={60} /></label>
          <label className="text-sm">Shop status
            <select className={inputClass} name="shopStatus" defaultValue={f.shopStatus ?? ""}>
              <option value="">All</option>
              <option value="ACTIVATED">Activated</option>
              <option value="NOT_ACTIVATED">Not activated</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-4">
            <button className="min-h-11 rounded-lg bg-kesari-700 px-4 font-semibold text-white" type="submit">Apply</button>
            <a className="inline-flex min-h-11 items-center underline" href={`/api/admin/dealer-dashboard?${query.toString()}&format=csv`}>Download CSV</a>
          </div>
        </form>
      </Card>
      <div className="grid gap-3 sm:grid-cols-3" data-testid="dashboard-tiles">
        {tiles.map(([k, v]) => (
          <Card key={k} className="p-3">
            <p className="text-xs text-ink-600">{k}</p>
            <p className="text-lg font-semibold text-ink-900">{v}</p>
          </Card>
        ))}
      </div>
      <Card className="overflow-x-auto p-4">
        <h2 className="mb-2 font-semibold">Scheme performance</h2>
        <table className="w-full text-left text-sm" data-testid="dashboard-schemes">
          <thead><tr><th className="p-1">Scheme</th><th className="p-1 text-right">Dealers</th><th className="p-1 text-right">Shops</th><th className="p-1 text-right">Activated</th><th className="p-1 text-right">Commission</th></tr></thead>
          <tbody>
            {d.schemes.map((s) => (
              <tr key={s.code} className="border-t border-cream-200"><td className="p-1">{s.name}</td><td className="p-1 text-right">{s.dealers}</td><td className="p-1 text-right">{s.shops}</td><td className="p-1 text-right">{s.activated}</td><td className="p-1 text-right">{rupees(s.commissionPaise)}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-2 font-semibold">Dealers by status</h2>
          <ul className="text-sm">{Object.entries(d.dealers.byStatus).map(([k, v]) => <li key={k}>{k.toLowerCase()}: {v}</li>)}</ul>
          <h2 className="mb-2 mt-3 font-semibold">Registrations by month</h2>
          <ul className="text-sm">{d.dealers.registrationsByMonth.length ? d.dealers.registrationsByMonth.map((r) => <li key={r.month}>{r.month}: {r.count}</li>) : <li>None in this period.</li>}</ul>
        </Card>
        <Card className="overflow-x-auto p-4">
          <h2 className="mb-2 font-semibold">Dealer-wise shops (top 20)</h2>
          <table className="w-full text-left text-sm">
            <thead><tr><th className="p-1">Dealer</th><th className="p-1">Scheme</th><th className="p-1 text-right">Shops</th><th className="p-1 text-right">Activated</th></tr></thead>
            <tbody>
              {d.shops.topDealers.map((t) => (
                <tr key={t.dealerId} className="border-t border-cream-200"><td className="p-1"><Link className="underline" href={`/admin/dealers/${t.dealerId}`}>{t.name}</Link></td><td className="p-1">{t.scheme ?? "—"}</td><td className="p-1 text-right">{t.shops}</td><td className="p-1 text-right">{t.activated}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
