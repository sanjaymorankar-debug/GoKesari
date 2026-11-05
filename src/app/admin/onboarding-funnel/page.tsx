import Link from "next/link";
import { redirect } from "next/navigation";

import { Card, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { FUNNEL_STAGES, getOnboardingFunnel, type FunnelStage } from "@/server/services/onboarding-funnel";

export const metadata = { title: "Shop onboarding funnel" };
export const dynamic = "force-dynamic";

const STAGE_LABEL: Record<FunnelStage, string> = {
  started: "Registration started",
  verified: "GST / PAN checked",
  paid: "Fee paid",
  live: "Live",
  firstProduct: "First product",
  firstOrder: "First order",
};

const SOURCE_LABEL = { ALL: "All registrations", SELF: "Self sign-up", DEALER: "Dealer / referral code", OPERATOR: "Operator on behalf" } as const;

const STEP_LABEL: Record<string, string> = {
  REFERRAL: "1. Referral code",
  EMAIL: "Shop email",
  DOCS_READY: "Documents question (old)",
  IDENTITY: "2. GST / PAN",
  UDYAM: "2. Udyam",
  FSSAI: "2. FSSAI",
  DETAILS: "3. Confirm details",
  REVIEW: "4. Review and pay",
  PAYMENT: "4. Payment",
};

/**
 * The shop onboarding funnel (onboarding Phase B, B3): registration → checked → paid → live →
 * first product → first order, by source, with the median time to go live and where open
 * registrations stopped. Staff with shop-registration rights.
 */
export default async function OnboardingFunnelPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_REGISTRATION_MANAGE)) redirect("/");
  const days = [7, 30, 90].includes(Number((await searchParams).days)) ? Number((await searchParams).days) : 30;
  const funnel = await getOnboardingFunnel(days);
  const all = funnel.rows.find((r) => r.source === "ALL");
  const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <Link href="/admin/menu/shops" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Shops
      </Link>
      <PageHeader title="Shop onboarding funnel" description={`Registrations started in the last ${funnel.days} days and how far they got. Times are from the registration's own steps.`} />
      <nav className="mb-4 flex gap-2 text-sm" aria-label="Period">
        {[7, 30, 90].map((d) => (
          <Link
            key={d}
            href={`/admin/onboarding-funnel?days=${d}`}
            className={`inline-flex min-h-11 items-center rounded-lg border px-3 ${d === days ? "border-kesari-600 bg-kesari-50 font-semibold" : "border-cream-200"}`}
            aria-current={d === days ? "page" : undefined}
          >
            {d} days
          </Link>
        ))}
      </nav>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-sm text-ink-500">Median time to go live</p>
          <p className="text-2xl font-semibold text-ink-900">{funnel.medianMinutesToLive == null ? "—" : `${funnel.medianMinutesToLive} min`}</p>
          <p className="text-xs text-ink-500">Target ≤ 5 min</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-ink-500">Median time live → first product</p>
          <p className="text-2xl font-semibold text-ink-900">{funnel.medianMinutesToFirstProduct == null ? "—" : `${funnel.medianMinutesToFirstProduct} min`}</p>
          <p className="text-xs text-ink-500">Target ≤ 3 min for 10 products</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-ink-500">Started → live</p>
          <p className="text-2xl font-semibold text-ink-900">{all ? pct(all.counts.live, all.counts.started) : "—"}</p>
          <p className="text-xs text-ink-500">{all ? `${all.counts.live} of ${all.counts.started}` : "No registrations yet"}</p>
        </Card>
      </div>

      <Card className="mb-4 overflow-x-auto p-0">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">Registrations by stage and source</caption>
          <thead className="bg-cream-50 text-left text-ink-600">
            <tr>
              <th scope="col" className="p-3">Source</th>
              {FUNNEL_STAGES.map((s) => (
                <th key={s} scope="col" className="p-3 text-right">
                  {STAGE_LABEL[s]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {funnel.rows.length === 0 ? (
              <tr>
                <td colSpan={FUNNEL_STAGES.length + 1} className="p-3 text-ink-500">
                  No registrations in this period.
                </td>
              </tr>
            ) : (
              funnel.rows.map((row) => (
                <tr key={row.source} className={`border-t border-cream-100 ${row.source === "ALL" ? "font-semibold" : ""}`}>
                  <th scope="row" className="p-3 text-left">{SOURCE_LABEL[row.source]}</th>
                  {FUNNEL_STAGES.map((s) => (
                    <td key={s} className="p-3 text-right tabular-nums">
                      {row.counts[s]}
                      {s !== "started" ? <span className="block text-xs font-normal text-ink-500">{pct(row.counts[s], row.counts.started)}</span> : null}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>

      <Card className="p-4">
        <h2 className="text-base font-semibold text-ink-900">Where open registrations stopped</h2>
        <p className="text-sm text-ink-500">Registrations not finished and untouched for a day or more, by the step they are on.</p>
        {funnel.abandonedAt.length === 0 ? (
          <p className="mt-2 text-sm text-ink-600">None.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {funnel.abandonedAt.map((a) => (
              <li key={a.step} className="flex justify-between border-b border-cream-100 py-1">
                <span>{STEP_LABEL[a.step] ?? a.step}</span>
                <span className="tabular-nums font-medium">{a.count}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
