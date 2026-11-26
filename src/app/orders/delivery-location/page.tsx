/**
 * docs/onboarding-v2-2026-11, step 5: where "Place order" (cash on delivery / wallet) lands when a delivery order
 * was placed before its address — the confirmation asks for the location at once. Nothing waiting: /orders.
 */
import { redirect } from "next/navigation";

import { PendingDeliveryLocation } from "@/components/onboarding-v2/pending-delivery-location";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listOrdersAwaitingAddress } from "@/server/onboarding-v2/customer";

export const metadata = { title: "Delivery location" };
export const dynamic = "force-dynamic";

export default async function DeliveryLocationPage({ searchParams }: { searchParams: Promise<{ placed?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if ((await listOrdersAwaitingAddress(user.id)).length === 0) redirect("/orders");
  const { placed } = await searchParams;
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Delivery location" description="Set where your order should go. Times are shown in IST." />
      <PendingDeliveryLocation userId={user.id} placed={placed === "1"} />
    </div>
  );
}
