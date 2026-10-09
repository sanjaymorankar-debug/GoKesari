import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge, Card, PageHeader, inputClass } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { healthQuerySchema, listIntegrationHealth } from "@/server/integrations/connections";
import { describeError } from "@/server/integrations/errors";
import { INTEGRATION_PROVIDERS } from "@/server/db/schema";

export const metadata = { title: "Accounting sync" };
export const dynamic = "force-dynamic";

const when = (d: Date | null) => (d ? d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "–");

/** Module 2: every connected shop's sync health, for support (read-only; no secrets). */
export default async function AdminIntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.INTEGRATION_VIEW_ANY)) redirect("/");
  const params = await searchParams;
  const query = healthQuerySchema.parse({
    provider: typeof params.provider === "string" && params.provider ? params.provider : undefined,
    problem: typeof params.problem === "string" && params.problem ? params.problem : undefined,
    q: typeof params.q === "string" && params.q ? params.q : undefined,
  });
  const rows = await listIntegrationHealth(query);
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Accounting sync" description="Shops connected to accounting software: connector status, last sync and failed entries. Open a shop to see its log and retry." />
      <form className="mb-4 flex flex-wrap gap-2">
        <input name="q" defaultValue={query.q ?? ""} placeholder="Shop name or number" className={`${inputClass} max-w-xs`} />
        <select name="provider" defaultValue={query.provider ?? ""} className={`${inputClass} max-w-[12rem]`}>
          <option value="">All software</option>
          {INTEGRATION_PROVIDERS.map((p) => <option key={p} value={p}>{p.replace("_", " ")}</option>)}
        </select>
        <select name="problem" defaultValue={query.problem ?? ""} className={`${inputClass} max-w-[12rem]`}>
          <option value="">All</option>
          <option value="any">Any problem</option>
          <option value="failed">Failed entries</option>
          <option value="offline">Connector offline</option>
        </select>
        <button type="submit" className="rounded-lg border border-cream-200 px-4 py-2 text-sm">Filter</button>
      </form>
      <Card className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-cream-100 text-left text-xs text-ink-500">
            <tr>
              <th className="px-3 py-2">Shop</th>
              <th className="px-3 py-2">Software</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Last read / sent</th>
              <th className="px-3 py-2">Waiting · retrying · failed</th>
              <th className="px-3 py-2">Last problem</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {rows.map((r) => (
              <tr key={r.shopId}>
                <td className="px-3 py-2">
                  <Link className="font-medium text-kesari-600 hover:underline" href={`/shop/settings/integrations/sync?shop=${r.shopId}`}>{r.shopName}</Link>
                  <span className="block text-xs text-ink-500">{r.registrationNumber}</span>
                </td>
                <td className="px-3 py-2">{r.label}</td>
                <td className="px-3 py-2 space-x-1">
                  <Badge tone={r.status === "ACTIVE" ? "success" : r.status === "PAUSED" ? "neutral" : "danger"}>{r.status.toLowerCase()}</Badge>
                  {r.connectorOnline != null ? <Badge tone={r.connectorOnline ? "success" : "warning"}>{r.connectorOnline ? "online" : "offline"}</Badge> : null}
                </td>
                <td className="px-3 py-2 text-xs">{when(r.lastPullAt)}<br />{when(r.lastPushAt)}</td>
                <td className="px-3 py-2">{r.jobs.waiting} · {r.jobs.retrying} · <span className={r.jobs.dead ? "font-semibold text-red-700" : ""}>{r.jobs.dead}</span></td>
                <td className="px-3 py-2 text-xs">{r.lastErrorCode ? `${describeError(r.lastErrorCode).message} (${when(r.lastErrorAt)})` : "–"}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-ink-500">No shops match.</td></tr>
            ) : null}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
