/**
 * Rider Refer & Earn (Rider App v2, rule riderReferral). Off: this page does not exist.
 * Shows the rider's code and share link, the terms from the rule and their referrals' progress.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ReferShare } from "@/components/rider-growth/refer-share";
import { RG, fill } from "@/components/rider-growth/text";
import { Alert, Card, PageHeader } from "@/components/ui";
import { tr, type Lang } from "@/lib/board/i18n";
import { formatPaiseCompact } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { getMyReferrals, type MyReferralRow } from "@/server/services/rider-referrals";

export const metadata = { title: "Refer & Earn" };
export const dynamic = "force-dynamic";

const STATUS: Record<MyReferralRow["status"], { text: keyof typeof RG; tone: string }> = {
  PENDING: { text: "statusPending", tone: "bg-amber-100 text-amber-800" },
  WAITING_APPROVAL: { text: "statusWaiting", tone: "bg-cream-100 text-ink-700" },
  QUALIFIED: { text: "statusQualified", tone: "bg-green-100 text-green-800" },
  EXPIRED: { text: "statusExpired", tone: "bg-cream-100 text-ink-600" },
};

function ReferralItem({ r, lang }: { r: MyReferralRow; lang: Lang }) {
  const s = STATUS[r.status];
  const progress = Math.round((r.delivered / Math.max(1, r.required)) * 100);
  return (
    <li className="py-3" data-testid="rider-referral-row">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-ink-900">{r.name}</span>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${s.tone}`}>{tr(RG[s.text], lang)}</span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-cream-200" aria-hidden>
        <div className="h-full rounded-full bg-kesari-600" style={{ width: `${progress}%` }} />
      </div>
      <p className="mt-1 text-xs text-ink-600">
        {r.delivered} / {r.required} {tr(RG.deliveries, lang)}
        {r.daysLeft != null ? ` · ${r.daysLeft} ${tr(RG.daysLeft, lang)}` : ""}
        {` · ${tr(RG.reward, lang)} ${formatPaiseCompact(r.rewardPaise)}`}
      </p>
    </li>
  );
}

export default async function RiderReferPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/delivery-partner/refer");
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) redirect("/delivery-partner");
  const [view, lang] = await Promise.all([getMyReferrals(partner.id), getBoardLang()]);
  if (!view.enabled) notFound();
  const t = view.terms;

  return (
    <div className="mx-auto max-w-2xl space-y-4" data-testid="rider-refer-page">
      <PageHeader title={tr(RG.referTitle, lang)} description={tr(RG.referIntro, lang)} />
      {!view.approved || !view.code ? (
        <Alert tone="warning">{tr(RG.notApproved, lang)}</Alert>
      ) : (
        <ReferShare code={view.code} lang={lang} />
      )}

      <Card className="p-4">
        <h2 className="text-lg font-semibold text-ink-900">{tr(RG.howItWorks, lang)}</h2>
        <ol className="mt-3 space-y-2 text-sm text-ink-700">
          {[tr(RG.step1, lang), tr(RG.step2, lang), fill(tr(RG.step3, lang), { n: t.deliveriesRequired, d: t.withinDays, amount: formatPaiseCompact(t.rewardPaise) })].map(
            (line, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-kesari-100 text-sm font-bold text-kesari-700">{i + 1}</span>
                <span className="pt-0.5">{line}</span>
              </li>
            ),
          )}
        </ol>
        <p className="mt-3 text-xs text-ink-500">{tr(RG.termsFixed, lang)}</p>
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-ink-900">{tr(RG.myReferrals, lang)}</h2>
          <span className="text-sm text-ink-600">
            {tr(RG.earned, lang)}: <strong className="text-green-800">{formatPaiseCompact(view.earnedPaise)}</strong>
          </span>
        </div>
        {view.referrals.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">{tr(RG.noReferrals, lang)}</p>
        ) : (
          <ul className="mt-2 divide-y divide-cream-100" data-testid="rider-referral-list">
            {view.referrals.map((r) => (
              <ReferralItem key={r.id} r={r} lang={lang} />
            ))}
          </ul>
        )}
      </Card>

      <Link href="/delivery-partner" className="inline-flex min-h-12 items-center text-sm font-semibold text-kesari-700 underline">
        {tr(RG.back, lang)}
      </Link>
    </div>
  );
}
