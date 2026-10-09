import { redirect } from "next/navigation";

import { ReferralRequestQueue } from "@/components/referral-request-queue";
import { CustomerReferralRequestQueue } from "@/components/customer-referral-request-queue";
import { listCustomerReferralRequests } from "@/server/services/customer-referral-requests";
import { Alert, Card, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { REFERRAL_REQUEST_STATUSES, type ReferralRequestStatus } from "@/server/db/schema";
import { listSignupReferralCounts } from "@/server/services/customer-signup-referrals";
import { listReferralRequests } from "@/server/services/referral-requests";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Referral requests" };
export const dynamic = "force-dynamic";

/** Operations: "Request a referral code" submissions (docs/four-features-2026-10, feature 4). */
export default async function AdminReferralRequestsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.REFERRAL_MANAGE)) redirect("/");
  const params = await searchParams;
  const status = (REFERRAL_REQUEST_STATUSES as readonly string[]).includes(params.status ?? "")
    ? (params.status as ReferralRequestStatus)
    : params.status === "ALL"
      ? null
      : "NEW";
  const [requests, rule, customerRule, joined, customerRequests] = await Promise.all([
    listReferralRequests(status, user),
    getRule("shopReferral"),
    getRule("customerSignupReferral"),
    listSignupReferralCounts(),
    listCustomerReferralRequests(status, user),
  ]);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Referral requests"
        description={`Shop owners asking for a referral code. Each request is emailed to ${rule.notifyEmails.join(", ")}; one per mobile number every ${rule.duplicateWindowHours} h.`}
      />
      {!rule.required ? <Alert tone="info">Referral codes are optional on registration right now (Business rules → shopReferral).</Alert> : null}
      <ReferralRequestQueue status={status ?? "ALL"} requests={requests} />

      {/* Customers asking for a referral code (owner's decision, 9 Oct 2026; same status filter). */}
      <section className="space-y-2" data-testid="customer-referral-requests">
        <h2 className="text-base font-semibold text-ink-900">Customers asking for a code</h2>
        <p className="text-sm text-ink-500">
          {customerRule.required
            ? "A referral code is needed before a new customer's first order."
            : "Referral codes are optional for customers right now (Business rules → customerSignupReferral → required)."}{" "}
          Each request is emailed to {rule.notifyEmails.join(", ")}.
        </p>
        <CustomerReferralRequestQueue requests={customerRequests} />
      </section>

      {/* Referral code at customer registration (rule customerSignupReferral). */}
      <section className="space-y-2" data-testid="signup-referral-counts">
        <h2 className="text-base font-semibold text-ink-900">Customers who joined with a code</h2>
        {!customerRule.enabled ? (
          <Alert tone="info">New customers are not asked for a referral code right now (Business rules → customerSignupReferral).</Alert>
        ) : null}
        {joined.length === 0 ? (
          <p className="text-sm text-ink-500">None yet.</p>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-cream-100 text-xs uppercase text-ink-500">
                <tr>
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2">Customers</th>
                  <th className="px-3 py-2">Latest</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-100">
                {joined.map((j) => (
                  <tr key={`${j.kind}:${j.code}`}>
                    <td className="px-3 py-2 font-mono">
                      {j.code}
                      {j.label ? <span className="block font-sans text-xs text-ink-500">{j.label}</span> : null}
                    </td>
                    <td className="px-3 py-2">{j.kind === "GOKESARI" ? "Issued by GoKesari" : "Friend's code"}</td>
                    <td className="px-3 py-2">{j.customers}</td>
                    <td className="px-3 py-2 text-xs">{new Date(j.latestAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </div>
  );
}
