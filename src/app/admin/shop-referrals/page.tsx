import { redirect } from "next/navigation";

import { ReverseShopReferralButton } from "@/components/shop-referrals/reverse-shop-referral";
import { Alert, Badge, Card, EmptyState, Money, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getRule } from "@/server/services/settings";
import { listShopReferrals } from "@/server/services/shop-referrals";

export const metadata = { title: "Shop referrals" };
export const dynamic = "force-dynamic";

/** Shop-refers-shop (0137): referrals with their outcome; a reward found fraudulent can be reversed (admin). */
export default async function ShopReferralsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") redirect("/");
  const [rows, rule] = await Promise.all([listShopReferrals(), getRule("shopReferrals")]);
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Shop referrals"
        description="A shop registers with another shop's code: the referring shop is rewarded when the new shop is approved and delivers its first order. Shared PAN, GSTIN, mobile, bank account or owner, a branch or a duplicate block the reward. A reward found fraudulent can be reversed."
      />
      {!rule.enabled ? <Alert tone="info">Rule shopReferrals is off: shops have no codes and nothing is credited (Admin → Settings → shopReferrals).</Alert> : null}
      {rows.length === 0 ? (
        <EmptyState title="No shop referrals yet." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm" data-testid="shop-referrals-table">
            <thead className="bg-cream-50 text-left text-ink-500">
              <tr>
                <th className="p-2">Referring shop</th>
                <th className="p-2">New shop</th>
                <th className="p-2">Status</th>
                <th className="p-2">Rewards</th>
                <th className="p-2">Registered</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-cream-200" data-testid="shop-referral-row">
                  <td className="p-2">
                    {r.referrerName}
                    <p className="text-xs text-ink-500">{r.code}</p>
                  </td>
                  <td className="p-2">{r.referredName}</td>
                  <td className="p-2">
                    <Badge tone={r.status === "REWARDED" ? "success" : r.status === "REJECTED" || r.status === "REVERSED" ? "danger" : "info"}>{r.status.toLowerCase()}</Badge>
                    {r.rejectionReason ? <p className="text-xs text-ink-500">{r.rejectionReason}</p> : null}
                    {r.reversalReason ? <p className="text-xs text-ink-500">{r.reversalReason}</p> : null}
                  </td>
                  <td className="p-2">
                    {r.discountPaise ? (
                      <p>
                        New shop: <Money paise={r.discountPaise} /> off the fee
                      </p>
                    ) : null}
                    {r.referredRewardPaise ? (
                      <p>
                        New shop: <Money paise={r.referredRewardPaise} /> credit
                      </p>
                    ) : null}
                    {r.referrerRewardPaise ? (
                      <p>
                        Referrer: <Money paise={r.referrerRewardPaise} /> credit
                      </p>
                    ) : null}
                    {r.referrerExtensionMonths ? <p>Referrer: +{r.referrerExtensionMonths} month(s) membership</p> : null}
                    {r.status === "REVERSED" ? (
                      <p className="text-xs text-ink-500">
                        Recovered <Money paise={(r.referrerRecoveredPaise ?? 0) + (r.referredRecoveredPaise ?? 0)} />
                      </p>
                    ) : null}
                    {r.status === "REWARDED" && user.role === "ADMIN" ? <ReverseShopReferralButton referralId={r.id} /> : null}
                  </td>
                  <td className="p-2">{r.createdAt.toISOString().slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
