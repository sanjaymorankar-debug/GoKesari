import { redirect } from "next/navigation";

import { Card, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getRule } from "@/server/services/settings";
import { smartShoppingStats } from "@/server/services/smart-list/stats";

export const metadata = { title: "Smart shopping" };
export const dynamic = "force-dynamic";

/**
 * docs/smart-shopping-2026-11: admin / operator dashboard — list scans per day, AI match accuracy (customer
 * edits vs AI suggestions), AI calls, response time and cost. Settings live in Rules (smartShopping,
 * whatsappShopOrders) and Feature flags.
 */
export default async function SmartShoppingDashboard({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.REPORT_VIEW_ALL) && !can(user.role, PERMISSIONS.REPORT_VIEW_OPERATIONAL)) redirect("/");
  const raw = Number((await searchParams).days);
  const days = [7, 30, 90].includes(raw) ? raw : 30;
  const [stats, rule] = await Promise.all([smartShoppingStats(days), getRule("smartShopping")]);
  const totalScans = stats.scans.reduce((s, d) => s + d.scans, 0);
  const totalCost = stats.ai.reduce((s, d) => s + d.costUsd, 0);
  return (
    <>
      <PageHeader
        title="Smart shopping"
        description={`Last ${days} days (IST). AI provider: ${rule.aiProvider}${rule.aiModel ? ` (${rule.aiModel})` : ""} · radius ${rule.comparisonRadiusKm} km · photos kept ${rule.photoRetentionDays} days. Change these in Settings → Rules.`}
      />
      <div className="mb-4 flex gap-2 text-sm">
        {[7, 30, 90].map((d) => (
          <a key={d} href={`/admin/smart-shopping?days=${d}`} className={`rounded-full px-3 py-1.5 ${d === days ? "bg-ink-900 text-white" : "border bg-white"}`}>
            {d} days
          </a>
        ))}
      </div>
      <div className="mb-6 grid gap-3 sm:grid-cols-4" data-testid="smart-kpis">
        <Card className="p-4">
          <div className="text-xs uppercase text-ink-500">List scans</div>
          <div className="text-2xl font-extrabold">{totalScans}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase text-ink-500">AI match accuracy</div>
          <div className="text-2xl font-extrabold">{stats.accuracy.accuracyPct == null ? "—" : `${stats.accuracy.accuracyPct}%`}</div>
          <div className="text-xs text-ink-500">
            {stats.accuracy.kept} of {stats.accuracy.aiMatched} AI matches kept · {stats.accuracy.unmatched} not matched by AI
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase text-ink-500">AI calls</div>
          <div className="text-2xl font-extrabold">{stats.ai.reduce((s, d) => s + d.calls, 0)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase text-ink-500">AI cost (est.)</div>
          <div className="text-2xl font-extrabold">${totalCost.toFixed(2)}</div>
        </Card>
      </div>
      <h2 className="mb-2 text-lg font-bold">Scans per day</h2>
      <table className="mb-6 w-full bg-white text-sm">
        <thead>
          <tr className="text-left">
            <th className="p-2">Day</th><th className="p-2 text-right">Scans</th><th className="p-2 text-right">Read</th><th className="p-2 text-right">Unreadable</th><th className="p-2 text-right">Lines</th>
          </tr>
        </thead>
        <tbody>
          {stats.scans.map((d) => (
            <tr key={d.day} className="border-t">
              <td className="p-2">{d.day}</td><td className="p-2 text-right">{d.scans}</td><td className="p-2 text-right">{d.read}</td><td className="p-2 text-right">{d.unreadable}</td><td className="p-2 text-right">{d.lines}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2 className="mb-2 text-lg font-bold">AI calls (response time, cost)</h2>
      <table className="w-full bg-white text-sm">
        <thead>
          <tr className="text-left">
            <th className="p-2">Day</th><th className="p-2">Feature</th><th className="p-2 text-right">Calls</th><th className="p-2 text-right">Failed</th><th className="p-2 text-right">Avg s</th><th className="p-2 text-right">p95 s</th><th className="p-2 text-right">Cost $</th>
          </tr>
        </thead>
        <tbody>
          {stats.ai.map((d) => (
            <tr key={`${d.day}-${d.feature}`} className="border-t">
              <td className="p-2">{d.day}</td><td className="p-2">{d.feature}</td><td className="p-2 text-right">{d.calls}</td><td className="p-2 text-right">{d.failed}</td>
              <td className="p-2 text-right">{(d.avgLatencyMs / 1000).toFixed(1)}</td><td className="p-2 text-right">{(d.p95LatencyMs / 1000).toFixed(1)}</td><td className="p-2 text-right">{d.costUsd.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
