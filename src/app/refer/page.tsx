import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { ApplyReferralCode, ReferralShare } from "@/components/referral-panel";
import { Alert, Card, EmptyState, Money, PageHeader } from "@/components/ui";
import { REFERRAL_COOKIE } from "@/lib/customer-referrals";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { canApplyReferralCode, getReferralSummary } from "@/server/services/customer-referrals";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Refer a friend" };
export const dynamic = "force-dynamic";

/** F11: the customer's referral code and link, results, and applying a friend's code. */
export default async function ReferPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const rule = await getRule("customerReferrals");
  if (!rule.enabled) {
    return (
      <>
        <PageHeader title="Refer a friend" />
        <EmptyState title="Referral rewards aren't available right now." />
      </>
    );
  }
  const [summary, canApply, jar, hdrs] = await Promise.all([getReferralSummary(user.id), canApplyReferralCode(user.id), cookies(), headers()]);
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host") ?? "gokesari.com";
  const proto = hdrs.get("x-forwarded-proto") ?? "https";
  const link = `${proto}://${host}/r/${summary.code}`;
  const pendingCode = jar.get(REFERRAL_COOKIE)?.value ?? "";

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Refer a friend" description="Share your code. When a friend's first order is delivered, you both get a reward." />
      <ReferralShare
        code={summary.code}
        link={link}
        rewardText={`You get ${formatPaise(rule.referrerRewardPaise)} and your friend gets ${formatPaise(rule.refereeRewardPaise)} in wallet credit after their first delivered order.`}
      />
      <Card className="grid grid-cols-3 gap-3 p-4 text-center text-sm">
        <div>
          <p className="text-2xl font-semibold text-ink-900">{summary.pending}</p>
          <p className="text-ink-500">Joined, first order pending</p>
        </div>
        <div>
          <p className="text-2xl font-semibold text-ink-900">{summary.rewarded}</p>
          <p className="text-ink-500">Rewarded</p>
        </div>
        <div>
          <p className="text-2xl font-semibold text-ink-900">
            <Money paise={summary.earnedPaise} />
          </p>
          <p className="text-ink-500">Earned</p>
        </div>
      </Card>
      {summary.referredBy ? (
        <Alert tone={summary.referredBy.status === "REWARDED" ? "success" : "info"}>
          {summary.referredBy.status === "PENDING"
            ? "You joined with a friend's code — your reward arrives after your first order is delivered."
            : summary.referredBy.status === "REWARDED"
              ? `You received ${formatPaise(summary.referredBy.rewardPaise ?? 0)} for joining with a friend's code.`
              : "Your friend's referral code could not be rewarded."}
        </Alert>
      ) : canApply ? (
        <ApplyReferralCode initialCode={pendingCode} />
      ) : null}
    </div>
  );
}
