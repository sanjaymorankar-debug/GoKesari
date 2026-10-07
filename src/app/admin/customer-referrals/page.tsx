import { redirect } from "next/navigation";

import { Badge, Card, EmptyState, Money, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listCustomerReferrals } from "@/server/services/customer-referrals";

export const metadata = { title: "Customer referrals" };
export const dynamic = "force-dynamic";

/** F11: customer referrals with their outcome (rewarded, pending, or rejected with the reason). */
export default async function CustomerReferralsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN") redirect("/");
  const rows = await listCustomerReferrals();
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Customer referrals"
        description="Rewards are paid automatically on the friend's first delivered order; duplicate-account signals block the reward."
      />
      {rows.length === 0 ? (
        <EmptyState title="No customer referrals yet." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-cream-50 text-left text-ink-500">
              <tr>
                <th className="p-2">Referrer</th>
                <th className="p-2">Friend</th>
                <th className="p-2">Status</th>
                <th className="p-2">Rewards</th>
                <th className="p-2">Joined</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-cream-200" data-testid="customer-referral-row">
                  <td className="p-2">{r.referrerName}</td>
                  <td className="p-2">{r.refereeName}</td>
                  <td className="p-2">
                    <Badge tone={r.status === "REWARDED" ? "success" : r.status === "REJECTED" ? "danger" : "info"}>{r.status.toLowerCase()}</Badge>
                    {r.rejectionReason ? <p className="text-xs text-ink-500">{r.rejectionReason}</p> : null}
                  </td>
                  <td className="p-2">
                    {r.status === "REWARDED" ? (
                      <>
                        <Money paise={r.referrerRewardPaise ?? 0} /> + <Money paise={r.refereeRewardPaise ?? 0} />
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="p-2">{r.createdAt.toLocaleDateString("en-IN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
