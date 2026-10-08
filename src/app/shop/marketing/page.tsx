import { redirect } from "next/navigation";

import {
  CampaignActions,
  CampaignForm,
  CodSettingToggle,
  DeleteSegmentButton,
  SegmentBuilder,
} from "@/components/growth-actions";
import { Card, EmptyState, Money, PageHeader, StatusBadge } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { COD_LIMITS } from "@/server/services/cod";
import {
  MARKETING_LIMITS,
  getShopCustomerOverview,
  listSegments,
  listShopCampaigns,
} from "@/server/services/marketing";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Marketing" };
export const dynamic = "force-dynamic";

function describeRules(rules: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(rules.pincodes) && rules.pincodes.length) parts.push(`PIN ${rules.pincodes.join(", ")}`);
  if (rules.minOrders) parts.push(`${rules.minOrders}+ delivered orders`);
  if (rules.orderedWithinDays) parts.push(`ordered in last ${rules.orderedWithinDays} days`);
  if (rules.lapsedForDays) parts.push(`no order for ${rules.lapsedForDays} days`);
  if (rules.minSpendPaise) parts.push(`spent ₹${(Number(rules.minSpendPaise) / 100).toFixed(0)}+`);
  return parts.length ? parts.join(" · ") : "All customers";
}

/**
 * Shop marketing portal (NAV-009): customer overview (counts only),
 * segments (GS-052), campaigns with approval and results (GS-053, WF-009,
 * KPI-015), and the cash-on-delivery setting (GS-030).
 */
export default async function ShopMarketingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.MARKETING_MANAGE_OWN)) redirect("/");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = shops[0];

  const [overview, segments, campaigns] = await Promise.all([
    getShopCustomerOverview(shop.id),
    listSegments(shop.id),
    listShopCampaigns(shop.id),
  ]);

  return (
    <>
      <PageHeader
        title="Marketing"
        description={`${shop.name} — reach your own customers who agreed to receive offers. Campaigns are checked by our team before they go out.`}
      />

      <section className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="customer-overview">
        <Card className="p-4">
          <p className="text-xs text-ink-500">Customers</p>
          <p className="mt-1 text-xl font-bold text-ink-900">{overview.customers}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Agreed to offers</p>
          <p className="mt-1 text-xl font-bold text-ink-900">{overview.consenting}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">Repeat (2+ delivered)</p>
          <p className="mt-1 text-xl font-bold text-ink-900">{overview.repeat}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-500">No order in 30 days</p>
          <p className="mt-1 text-xl font-bold text-ink-900">{overview.lapsed}</p>
        </Card>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-base font-semibold text-ink-900">Segments</h2>
        <Card className="mb-3 p-4">
          <SegmentBuilder shopId={shop.id} />
        </Card>
        {segments.length === 0 ? (
          <EmptyState title="No segments yet." />
        ) : (
          <Card className="divide-y divide-cream-100">
            {segments.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <div>
                  <p className="font-medium text-ink-900">{s.name}</p>
                  <p className="text-xs text-ink-500">
                    {describeRules(s.rules as Record<string, unknown>)} · {s.matched} match · {s.reachable} reachable
                  </p>
                </div>
                <DeleteSegmentButton shopId={shop.id} segmentId={s.id} />
              </div>
            ))}
          </Card>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-1 text-base font-semibold text-ink-900">Campaigns</h2>
        <p className="mb-2 text-xs text-ink-500">
          Up to {MARKETING_LIMITS.shopCampaignsPerWeek} campaigns a week. A customer gets at most{" "}
          {MARKETING_LIMITS.perShopPerCustomerPerWeek} message from you and {MARKETING_LIMITS.totalPerCustomerPerWeek} in total a week.
        </p>
        <Card className="mb-3 p-4">
          <CampaignForm shopId={shop.id} segments={segments.map((s) => ({ id: s.id, name: s.name, reachable: s.reachable }))} />
        </Card>
        {campaigns.length === 0 ? (
          <EmptyState title="No campaigns yet." />
        ) : (
          <Card className="divide-y divide-cream-100" data-testid="campaign-list">
            {campaigns.map((c) => (
              <div key={c.id} className="space-y-1 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-ink-900">
                    {c.title} <span className="text-xs text-ink-500">→ {c.segmentName} · budget {c.maxRecipients}</span>
                  </p>
                  <StatusBadge status={c.status} />
                </div>
                <p className="text-xs text-ink-600">{c.message}</p>
                {c.rejectionReason ? <p className="text-xs text-red-700">Not approved: {c.rejectionReason}</p> : null}
                {c.status === "SENT" ? (
                  <p className="text-xs text-ink-600">
                    Sent to {c.sentCount} ({c.suppressedCount} skipped by limits) · opened {c.stats.opened} · ordered{" "}
                    {c.stats.converted} within {c.attributionDays} days · <Money paise={c.stats.revenuePaise} />
                  </p>
                ) : null}
                <CampaignActions shopId={shop.id} campaignId={c.id} status={c.status} />
              </div>
            ))}
          </Card>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-base font-semibold text-ink-900">Payment options</h2>
        <Card className="p-4">
          <CodSettingToggle shopId={shop.id} enabled={shop.codEnabled} maxOrderPaise={COD_LIMITS.maxOrderPaise} />
        </Card>
      </section>
    </>
  );
}
