import { redirect } from "next/navigation";

import { Alert, PageHeader } from "@/components/ui";
import { formatIst } from "@/lib/consult/time";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listPolicies, riderInsuranceEnabled } from "@/server/services/rider-insurance";
import { RiderInsuranceManager } from "./rider-insurance-manager";

export const metadata = { title: "Rider insurance" };
export const dynamic = "force-dynamic";

/** Rider App v2: the group insurance policy riders see on /delivery-partner/insurance. One active at a time. */
export default async function RiderInsuranceAdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/admin/rider-insurance");
  if (!can(user.role, PERMISSIONS.DELIVERY_PARTNER_MANAGE)) redirect("/");
  const [policies, enabled] = await Promise.all([listPolicies(), riderInsuranceEnabled()]);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Rider insurance"
        description="The policy riders see: covers, who is eligible, network hospitals and how to claim. Only one policy is active at a time — activating one switches the others off and tells the riders covered now."
      />
      {!enabled ? (
        <Alert tone="info">The rider insurance screen is switched off (rule riderInsurance). You can prepare the policy now; riders see it once the rule is on.</Alert>
      ) : null}
      <RiderInsuranceManager
        policies={policies.map((p) => ({
          id: p.id,
          insurer: p.insurer,
          policyNumber: p.policyNumber,
          healthCoverRupees: p.healthCoverPaise / 100,
          accidentCoverRupees: p.accidentCoverPaise / 100,
          opdCoverRupees: p.opdCoverPaise / 100,
          minDeliveries: p.minDeliveries,
          lookbackDays: p.lookbackDays,
          validFrom: p.validFrom,
          validTo: p.validTo,
          hospitalsUrl: p.hospitalsUrl ?? "",
          hospitals: p.hospitals.map((h) => ({ name: h.name, city: h.city, address: h.address ?? "", phone: h.phone ?? "" })),
          claimHelp: p.claimHelp ?? "",
          isActive: p.isActive,
          updatedAt: formatIst(p.updatedAt),
        }))}
      />
    </div>
  );
}
