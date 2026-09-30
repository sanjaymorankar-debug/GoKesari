import Link from "next/link";
import { redirect } from "next/navigation";

import { CampaignDecisionButtons } from "@/components/growth-actions";
import { Card, EmptyState, Money, PageHeader, StatusBadge } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listCampaignsForReview } from "@/server/services/marketing";

export const metadata = { title: "Campaigns" };
export const dynamic = "force-dynamic";

const STATUSES = ["SUBMITTED", "APPROVED", "SENT", "REJECTED"] as const;

/** Operations: approve or reject shop campaigns before they are sent (WF-009). */
export default async function AdminCampaignsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.MARKETING_APPROVE)) redirect("/");
  const { status } = await searchParams;
  const current = (STATUSES as readonly string[]).includes(status ?? "") ? (status as (typeof STATUSES)[number]) : "SUBMITTED";
  const rows = await listCampaignsForReview(current);

  return (
    <>
      <PageHeader title="Campaigns" description="Check each message is honest, relevant and respectful before customers receive it." />
      <nav className="mb-4 flex flex-wrap gap-2 text-sm">
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/admin/campaigns?status=${s}`}
            className={`rounded-lg border px-3 py-1 ${s === current ? "border-kesari-400 bg-kesari-50" : "border-cream-200"}`}
          >
            {s.toLowerCase()}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <EmptyState title={`No ${current.toLowerCase()} campaigns.`} />
      ) : (
        <Card className="divide-y divide-cream-100">
          {rows.map(({ campaign: c, shopName, segmentName, stats }) => (
            <div key={c.id} className="space-y-1 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium text-ink-900">
                  {shopName}: {c.title} <span className="text-xs text-ink-500">→ {segmentName} · budget {c.maxRecipients}</span>
                </p>
                <StatusBadge status={c.status} />
              </div>
              <p className="text-ink-700">{c.message}</p>
              {c.offerText ? <p className="text-xs text-ink-600">Offer: {c.offerText}</p> : null}
              {c.rejectionReason ? <p className="text-xs text-ink-500">Rejected: {c.rejectionReason}</p> : null}
              {c.status === "SENT" ? (
                <p className="text-xs text-ink-600">
                  Sent {c.sentCount} · opened {stats.opened} · converted {stats.converted} · <Money paise={stats.revenuePaise} />
                </p>
              ) : null}
              {c.status === "SUBMITTED" ? <CampaignDecisionButtons campaignId={c.id} /> : null}
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
