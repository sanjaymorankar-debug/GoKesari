import Link from "next/link";
import { redirect } from "next/navigation";

import { MembershipExemptionToggle } from "@/components/membership-exemption-toggle";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import type { MembershipState } from "@/server/services/shop-membership";
import { MEMBERSHIP_REPORT_STATES, membershipReport, type MembershipReportState } from "@/server/services/shop-membership-renewal";

export const metadata = { title: "Shop memberships" };
export const dynamic = "force-dynamic";

const LABELS: Record<MembershipReportState, string> = {
  ALL: "All",
  ACTIVE: "Active",
  DUE_SOON: "Due soon",
  GRACE: "In grace",
  LAPSED: "Lapsed",
  NONE: "No end date",
  EXEMPT: "Exempt",
};
const TONE: Record<MembershipState, "success" | "warning" | "danger" | "info" | "neutral"> = {
  ACTIVE: "success",
  DUE_SOON: "warning",
  GRACE: "warning",
  LAPSED: "danger",
  NONE: "neutral",
  EXEMPT: "info",
};

/**
 * Shop memberships (docs/shop-membership-renewal-2026-11): every shop by membership state and end date,
 * with CSV export and the per-shop exemption (admin only, audited). The switches (renewal checkout,
 * reminders, fee, exempt shop types / categories) are in Admin → Settings, rule shopMembership.
 */
export default async function ShopMembershipsPage({ searchParams }: { searchParams: Promise<{ state?: string; q?: string; within?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.PAYMENT_VIEW_ANY)) redirect("/");
  const params = await searchParams;
  const state: MembershipReportState = (MEMBERSHIP_REPORT_STATES as readonly string[]).includes(params.state ?? "") ? (params.state as MembershipReportState) : "ALL";
  const q = (params.q ?? "").slice(0, 80);
  const within = params.within && /^\d{1,4}$/.test(params.within) ? Number(params.within) : null;
  const { rows, counts, rule } = await membershipReport({ state, q, endsWithinDays: within });
  const isAdmin = user.role === "ADMIN";
  const day = (d: Date | null) => (d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: getEnv().APP_TIMEZONE }) : "—");
  const qs = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const merged = { state, q: q || null, within: within != null ? String(within) : null, ...extra };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return p.toString();
  };
  const csv = new URLSearchParams({ format: "csv", state, ...(q ? { q } : {}), ...(within != null ? { endsWithinDays: String(within) } : {}) }).toString();

  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/admin/menu/shops" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Shops
      </Link>
      <PageHeader
        title="Shop memberships"
        description={`Yearly membership (${rule.periodMonths} months, ${rule.graceDays} grace days). Closing lapsed shops: ${rule.enabled ? "on" : "off — nobody is closed"}. Online renewal: ${rule.renewalCheckoutEnabled ? "open" : "off"}. Reminders: ${rule.remindersEnabled ? "on" : "off"}. Change these in Settings (rule shopMembership).`}
      />
      <nav className="mb-3 flex flex-wrap gap-2" aria-label="Filter by state">
        {MEMBERSHIP_REPORT_STATES.map((key) => (
          <Link
            key={key}
            href={`/admin/shops/memberships?${qs({ state: key })}`}
            aria-current={key === state ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium ${key === state ? "border-kesari-600 bg-kesari-50 text-kesari-800" : "border-cream-300 text-ink-700"}`}
          >
            {LABELS[key]}
            {key !== "ALL" ? ` (${counts[key as MembershipState]})` : ""}
          </Link>
        ))}
      </nav>
      <form className="mb-4 flex flex-wrap items-end gap-2" action="/admin/shops/memberships">
        <input type="hidden" name="state" value={state} />
        <label className="text-sm text-ink-700">
          Search
          <input name="q" defaultValue={q} placeholder="Shop, number or mobile" className="ml-2 min-h-11 rounded border border-cream-300 px-2" />
        </label>
        <label className="text-sm text-ink-700">
          Ends within (days)
          <input name="within" defaultValue={within ?? ""} inputMode="numeric" className="ml-2 min-h-11 w-20 rounded border border-cream-300 px-2" />
        </label>
        <button type="submit" className="min-h-11 rounded bg-kesari-600 px-4 text-sm font-semibold text-white">
          Filter
        </button>
        <a href={`/api/admin/shop-memberships?${csv}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 underline">
          Download CSV
        </a>
      </form>
      {rows.length === 0 ? (
        <EmptyState title="No shops match." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="membership-report">
            <thead className="bg-cream-100 text-xs uppercase text-ink-500">
              <tr>
                <th className="px-3 py-2">Shop</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Valid until</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2">Last renewal</th>
                <th className="px-3 py-2">Exemption</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {rows.map((r) => (
                <tr key={r.shopId}>
                  <td className="px-3 py-2">
                    <Link href={`/admin/shops/${r.shopId}`} className="font-medium text-ink-900 hover:underline">
                      {r.shopName}
                    </Link>
                    <span className="block text-xs text-ink-500">
                      {r.registrationNumber} · {r.city} · {r.shopStatus.replace(/_/g, " ").toLowerCase()}
                    </span>
                  </td>
                  <td className="px-3 py-2">{r.shopType}</td>
                  <td className="px-3 py-2">{day(r.validUntil)}</td>
                  <td className="px-3 py-2">
                    <Badge tone={TONE[r.state]}>{LABELS[r.state]}</Badge>
                    {!r.enforced && r.state !== "EXEMPT" && r.state !== "NONE" ? <span className="block text-xs text-ink-500">not enforced</span> : null}
                  </td>
                  <td className="px-3 py-2">{day(r.lastRenewalAt)}</td>
                  <td className="px-3 py-2">
                    {r.exemptReason ? <span className="block text-xs text-ink-600">{r.exemptReason}</span> : null}
                    {isAdmin ? <MembershipExemptionToggle shopId={r.shopId} shopName={r.shopName} exempt={r.manualExempt} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
