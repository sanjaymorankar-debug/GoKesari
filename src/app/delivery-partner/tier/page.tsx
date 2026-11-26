/**
 * Rider tier badge (Rider App v2, rule riderTiers). Off: this page does not exist.
 * The tier, its perks, the last-7-day metrics and what the next tier still needs.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { RG, fill } from "@/components/rider-growth/text";
import { Card, PageHeader } from "@/components/ui";
import { tr, type Lang, type Text } from "@/lib/board/i18n";
import type { TierMetric } from "@/lib/rider-growth";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { getRiderTier } from "@/server/services/rider-tiers";

export const metadata = { title: "My tier" };
export const dynamic = "force-dynamic";

const METRIC_LABEL: Record<TierMetric, Text> = {
  deliveries: RG.mDeliveries,
  rating: RG.mRating,
  acceptance: RG.mAcceptance,
  onTime: RG.mOnTime,
};

function show(metric: TierMetric, value: number): string {
  if (metric === "rating") return (value / 100).toFixed(1);
  if (metric === "acceptance" || metric === "onTime") return `${value}%`;
  return String(value);
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border-2 border-cream-200 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-ink-900">{value}</p>
      {note ? <p className="text-xs text-ink-500">{note}</p> : null}
    </div>
  );
}

export default async function RiderTierPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/delivery-partner/tier");
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) redirect("/delivery-partner");
  const [view, lang] = await Promise.all([getRiderTier(partner.id), getBoardLang()]);
  if (!view.enabled) notFound();
  const m = view.metrics;
  const l = (text: Text) => tr(text, lang as Lang);

  return (
    <div className="mx-auto max-w-2xl space-y-4" data-testid="rider-tier-page">
      <PageHeader title={l(RG.tierTitle)} description={l(RG.tierIntro)} />

      <div className="rounded-2xl border-2 border-kesari-200 bg-kesari-50 p-4" data-testid="rider-tier-badge">
        <p className="text-3xl font-bold text-kesari-700">{view.tier?.name ?? l(RG.noTier)}</p>
        {view.tier ? (
          <div className="mt-2 flex flex-wrap gap-2 text-sm">
            {view.tier.extraIncentivePct > 0 ? (
              <span className="rounded-full bg-green-100 px-3 py-1 font-semibold text-green-800">
                +{view.tier.extraIncentivePct}% {l(RG.extraIncentive)}
              </span>
            ) : null}
            {view.tier.priority ? <span className="rounded-full bg-blue-100 px-3 py-1 font-semibold text-blue-800">{l(RG.priorityPerk)}</span> : null}
          </div>
        ) : null}
      </div>

      <Card className="p-4">
        <h2 className="text-lg font-semibold text-ink-900">{l(RG.last7)}</h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Metric label={l(RG.mDeliveries)} value={String(m.deliveries)} />
          <Metric label={l(RG.mRating)} value={m.ratingCount > 0 ? (m.ratingX100 / 100).toFixed(1) : "—"} />
          <Metric label={l(RG.mAcceptance)} value={m.acceptancePct == null ? "—" : `${m.acceptancePct}%`} note={m.acceptancePct == null ? l(RG.noData) : undefined} />
          <Metric label={l(RG.mOnTime)} value={m.onTimePct == null ? "—" : `${m.onTimePct}%`} note={m.onTimePct == null ? l(RG.noData) : undefined} />
        </div>
      </Card>

      <Card className="p-4" data-testid="rider-tier-next">
        {view.next ? (
          view.next.needs.length === 0 ? (
            <p className="text-sm text-ink-700">{fill(l(RG.nextReady), { name: view.next.name })}</p>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-ink-900">{fill(l(RG.nextTier), { name: view.next.name })}</h2>
              <ul className="mt-2 space-y-2">
                {view.next.needs.map((n) => (
                  <li key={n.metric} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-cream-50 px-3 py-2 text-sm">
                    <span className="font-semibold text-ink-800">{l(METRIC_LABEL[n.metric])}</span>
                    <span className="text-ink-700">
                      {show(n.metric, n.have)} → {show(n.metric, n.need)}
                      {n.metric === "deliveries" ? ` (${n.need - n.have} ${l(RG.more)})` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )
        ) : (
          <p className="text-sm text-ink-700">{l(RG.topTier)}</p>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="text-lg font-semibold text-ink-900">{l(RG.allTiers)}</h2>
        <ul className="mt-2 divide-y divide-cream-100 text-sm">
          {view.tiers.map((t) => (
            <li key={t.name} className={`py-2 ${t.name === view.tier?.name ? "font-bold text-kesari-700" : "text-ink-700"}`}>
              <span>{t.name}</span>
              <span className="block text-xs font-normal text-ink-500">
                {l(RG.mDeliveries)} {t.minDeliveries}+ · {l(RG.mRating)} {(t.minRatingX100 / 100).toFixed(1)}+ · {l(RG.mAcceptance)} {t.minAcceptancePct}%+ ·{" "}
                {l(RG.mOnTime)} {t.minOnTimePct}%+
                {t.extraIncentivePct > 0 ? ` · +${t.extraIncentivePct}%` : ""}
                {t.priority ? ` · ${l(RG.priorityPerk)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Link href="/delivery-partner" className="inline-flex min-h-12 items-center text-sm font-semibold text-kesari-700 underline">
        {l(RG.back)}
      </Link>
    </div>
  );
}
