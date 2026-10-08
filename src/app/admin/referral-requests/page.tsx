import { redirect } from "next/navigation";

import { ReferralRequestQueue } from "@/components/referral-request-queue";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { REFERRAL_REQUEST_STATUSES, type ReferralRequestStatus } from "@/server/db/schema";
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
  const [requests, rule] = await Promise.all([listReferralRequests(status, user), getRule("shopReferral")]);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Referral requests"
        description={`Shop owners asking for a referral code. Each request is emailed to ${rule.notifyEmails.join(", ")}; one per mobile number every ${rule.duplicateWindowHours} h.`}
      />
      {!rule.required ? <Alert tone="info">Referral codes are optional on registration right now (Business rules → shopReferral).</Alert> : null}
      <ReferralRequestQueue status={status ?? "ALL"} requests={requests} />
    </div>
  );
}
