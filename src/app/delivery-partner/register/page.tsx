import { redirect } from "next/navigation";

import { DeliveryPartnerRegisterForm } from "@/components/delivery-partner-register-form";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";

export const metadata = { title: "Delivery Partner Registration" };
export const dynamic = "force-dynamic";

export default async function DeliveryPartnerRegisterPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const existing = await getMyDeliveryPartnerProfile(user.id);
  if (existing) redirect("/delivery-partner");

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Delivery Partner Registration"
        description="Step 1 of 3: your details, vehicle, emergency contact and current location. Next: PAN and Aadhaar verification, then your police verification documents."
      />
      <DeliveryPartnerRegisterForm />
    </div>
  );
}
