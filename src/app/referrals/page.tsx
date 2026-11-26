import Link from "next/link";
import { redirect } from "next/navigation";

import { Alert, Card, EmptyState, Money, PageHeader } from "@/components/ui";
import { CHANNEL_LABEL, isShareChannel } from "@/lib/referral-share";
import { getCurrentUser } from "@/server/authz/guards";
import { getOrCreateReferralCode } from "@/server/services/customer-referrals";
import { myReferralStats, referralSharingOn } from "@/server/services/referral-links";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "My referrals" };
export const dynamic = "force-dynamic";

const SHARE_PAGE: Record<string, string> = { CUSTOMER: "/refer", SHOP: "/shop/manage/registration", DEALER: "/dealer", FRANCHISE: "/franchise/my" };

/**
 * docs/referral-sharing-2026-11: every referral code the signed-in person owns — customer, shop,
 * dealer / team lead / agent, franchise — with shares (by channel), link clicks, sign-ups, pending
 * and earned. Sign-ups, pending and earned are read from the existing referral and commission tables.
 */
export default async function MyReferralsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if ((await getRule("customerReferrals")).enabled) await getOrCreateReferralCode(user.id);
  const [stats, sharing] = await Promise.all([myReferralStats(user.id), referralSharingOn()]);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="My referrals" description="How your referral links are doing: shares, link opens, sign-ups and what you have earned." />
      {!sharing ? <Alert tone="info">Share tracking is switched off. Sign-ups and earnings still show.</Alert> : null}
      {stats.length === 0 ? (
        <EmptyState title="You have no referral code yet." />
      ) : (
        stats.map((s) => (
          <Card key={s.code} className="space-y-3 p-4" data-testid="my-referral-code-card" data-code={s.code}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p>
                <span className="font-mono text-lg font-bold text-kesari-800">{s.code}</span> <span className="text-sm text-ink-500">· {s.level}</span>
              </p>
              {SHARE_PAGE[s.kind] ? (
                <Link className="text-sm font-semibold text-kesari-700 underline" href={SHARE_PAGE[s.kind]}>
                  Share this code
                </Link>
              ) : null}
            </div>
            <dl className="grid grid-cols-2 gap-3 text-center text-sm sm:grid-cols-5">
              <Stat label="Shared" value={s.shares} testid="stat-shares" />
              <Stat label="Link opens" value={s.clicks} testid="stat-clicks" />
              <Stat label="Signed up" value={s.signups} testid="stat-signups" />
              <Stat label="Pending" value={s.pending} testid="stat-pending" />
              <div>
                <dd className="text-xl font-semibold text-ink-900" data-testid="stat-earned">
                  <Money paise={s.earnedPaise} />
                </dd>
                <dt className="text-ink-500">Earned</dt>
              </div>
            </dl>
            {s.pendingPaise ? (
              <p className="text-sm text-ink-600">
                Commission pending: <Money paise={s.pendingPaise} />
              </p>
            ) : null}
            {Object.keys(s.sharesByChannel).length ? (
              <p className="text-xs text-ink-500" data-testid="stat-channels">
                {Object.entries(s.sharesByChannel)
                  .map(([c, n]) => `${isShareChannel(c) ? CHANNEL_LABEL[c] : c}: ${n}`)
                  .join(" · ")}
              </p>
            ) : null}
          </Card>
        ))
      )}
    </div>
  );
}

function Stat({ label, value, testid }: { label: string; value: number; testid: string }) {
  return (
    <div>
      <dd className="text-xl font-semibold text-ink-900" data-testid={testid}>
        {value}
      </dd>
      <dt className="text-ink-500">{label}</dt>
    </div>
  );
}
