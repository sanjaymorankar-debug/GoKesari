import Link from "next/link";
import { redirect } from "next/navigation";

import { SuspendShopButton } from "@/components/registration/admin-actions";
import { Badge, Card, PageHeader, inputClass } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { autoApprovedQuerySchema, listAutoApprovedShops, listDistributors } from "@/server/registration/admin";

export const metadata = { title: "Auto-approved shops" };
export const dynamic = "force-dynamic";

const date = (d: Date | null) => (d ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "–");

/** Module 3: shops approved by their registration payment; one-click suspend. */
export default async function AutoApprovedShopsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_REGISTRATION_MANAGE)) redirect("/");
  const params = await searchParams;
  const pick = (k: string) => (typeof params[k] === "string" && params[k] ? (params[k] as string) : undefined);
  const query = autoApprovedQuerySchema.parse({ code: pick("code"), distributorId: pick("distributorId"), from: pick("from"), to: pick("to"), profile: pick("profile"), q: pick("q") });
  const [rows, distributors] = await Promise.all([listAutoApprovedShops(query), listDistributors()]);
  const canSuspend = can(user.role, PERMISSIONS.SHOP_SUSPEND);
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Auto-approved shops" description="Shops that registered themselves and were approved by their payment. Check new ones, and suspend in one click if something is wrong." />
      <form className="mb-4 grid gap-2 sm:grid-cols-6">
        <input name="q" defaultValue={query.q ?? ""} placeholder="Name, shop no., mobile" className={inputClass} />
        <input name="code" defaultValue={query.code ?? ""} placeholder="Referral code" className={inputClass} />
        <select name="distributorId" defaultValue={query.distributorId ?? ""} className={inputClass}>
          <option value="">All distributors</option>
          {distributors.map((d) => <option key={d.distributor.id} value={d.distributor.id}>{d.distributor.name}</option>)}
        </select>
        <input type="date" name="from" defaultValue={query.from ?? ""} className={inputClass} aria-label="From" />
        <input type="date" name="to" defaultValue={query.to ?? ""} className={inputClass} aria-label="To" />
        <div className="flex gap-2">
          <select name="profile" defaultValue={query.profile ?? ""} className={inputClass}>
            <option value="">Any profile</option>
            <option value="complete">Profile complete</option>
            <option value="incomplete">Profile incomplete</option>
          </select>
          <button type="submit" className="rounded-lg border border-cream-200 px-3 text-sm">Filter</button>
        </div>
      </form>
      <Card className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-cream-100 text-left text-xs text-ink-500">
            <tr>
              <th className="px-3 py-2">Shop</th><th className="px-3 py-2">Approved</th><th className="px-3 py-2">Plan · fee paid</th><th className="px-3 py-2">Code · distributor</th><th className="px-3 py-2">Commission</th><th className="px-3 py-2">Profile</th><th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {rows.map((r) => (
              <tr key={r.shopId}>
                <td className="px-3 py-2">
                  <Link href={`/admin/shops/${r.shopId}`} className="font-medium text-kesari-600 hover:underline">{r.name}</Link>
                  <span className="block text-xs text-ink-500">{r.registrationNumber} · {r.ownerPhone}</span>
                </td>
                <td className="px-3 py-2 text-xs">{date(r.approvedAt)}</td>
                <td className="px-3 py-2">{r.tier ?? "–"} · {formatPaise(Number(r.feePaise))}</td>
                <td className="px-3 py-2">{r.code ?? "–"}<span className="block text-xs text-ink-500">{r.distributorName ?? "no distributor"}</span></td>
                <td className="px-3 py-2">{r.commissionPaise != null ? `${formatPaise(Number(r.commissionPaise))} (${r.commissionStatus?.toLowerCase()})` : "–"}</td>
                <td className="px-3 py-2">{r.profileCompletedAt ? <Badge tone="success">complete</Badge> : <Badge tone="warning">incomplete</Badge>}</td>
                <td className="px-3 py-2">{r.status === "APPROVED" && canSuspend ? <SuspendShopButton shopId={r.shopId} shopName={r.name} /> : <Badge tone={r.status === "APPROVED" ? "success" : "danger"}>{r.status.toLowerCase()}</Badge>}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={7} className="px-3 py-6 text-center text-ink-500">No shops match.</td></tr> : null}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
