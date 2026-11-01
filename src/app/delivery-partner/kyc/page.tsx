import { redirect } from "next/navigation";

import { RiderKycForm } from "@/components/rider-kyc-form";
import { LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { getMyRiderKyc } from "@/server/services/rider-kyc";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "PAN and Aadhaar verification" };
export const dynamic = "force-dynamic";

/** Gig worker flow (feature 2): step 2 of registration. */
export default async function RiderKycPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) redirect("/delivery-partner/register");
  const [kyc, rule] = await Promise.all([getMyRiderKyc(user.id), getRule("riderVerification")]);
  const view = (c: typeof kyc.pan) =>
    c ? { status: c.status, numberMasked: c.numberMasked, reason: c.reason, awaitingOtp: c.awaitingOtp, digilockerOpen: c.digilockerOpen } : null;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="PAN and Aadhaar verification"
        description="Step 2 of 3. We check your PAN with the government records through our verification partner, and you share your Aadhaar from DigiLocker — with your consent."
      />
      <RiderKycForm pan={view(kyc.pan)} aadhaar={view(kyc.aadhaar)} aadhaarMethod={rule.aadhaarMethod} />
      <div className="mt-6 flex flex-wrap gap-2">
        <LinkButton href="/delivery-partner/documents">Next: police verification documents</LinkButton>
        <LinkButton href="/delivery-partner" variant="secondary">
          Back to my application
        </LinkButton>
      </div>
    </div>
  );
}
