/**
 * docs/delta CF-006: a rider asks housing societies to add them to their rider list.
 * Only while the flag society_rider_join_requests_enabled is on (each request is also checked
 * against the society's district on the server); otherwise this page does not exist.
 */
import { notFound, redirect } from "next/navigation";

import { RiderSocietyJoin } from "@/components/delta/society-join";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { SOCIETY_JOIN_FLAG, listMyJoinRequests } from "@/server/services/delta/society-join-requests";
import { getFeatureFlag } from "@/server/services/feature-flags";

export const metadata = { title: "Join a society" };
export const dynamic = "force-dynamic";

export default async function RiderSocietiesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/delivery-partner/societies");
  if (!(await getFeatureFlag(SOCIETY_JOIN_FLAG)).enabled) notFound();
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) redirect("/delivery-partner");

  const requests = await listMyJoinRequests(user);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Join a society" description="Ask a housing society to add you to its rider list." />
      {partner.status !== "APPROVED" ? (
        <Alert tone="warning">You can ask societies once your delivery partner account is approved.</Alert>
      ) : (
        <RiderSocietyJoin
          initialRequests={requests.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))}
        />
      )}
    </div>
  );
}
