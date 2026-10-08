import Link from "next/link";
import { redirect } from "next/navigation";

import { DeliveryStaffManager } from "@/components/delivery-staff-manager";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listDeliveryStaff, getSlotRules } from "@/server/services/fulfilment-options";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Delivery staff" };
export const dynamic = "force-dynamic";

/** The shop's own delivery people (docs/four-features-2026-10, feature 1). */
export default async function DeliveryStaffPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) {
    return (
      <>
        <PageHeader title="Delivery staff" />
        <EmptyState title="You haven't registered a shop yet" />
      </>
    );
  }
  const params = await searchParams;
  const shop = shops.find((s) => s.id === params.shop) ?? shops[0];
  const [staff, rules] = await Promise.all([listDeliveryStaff(shop.id), getSlotRules()]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="Delivery staff"
        description={`${shop.name} — the people who deliver your orders themselves.`}
        action={
          <Link href="/shop/orders" className="text-sm font-medium text-kesari-600 hover:underline">
            Orders →
          </Link>
        }
      />
      {!rules.enabled ? (
        <Alert tone="info">Choosing your own delivery for an order is not switched on yet. You can add your team now.</Alert>
      ) : null}
      <DeliveryStaffManager shopId={shop.id} staff={staff} />
    </div>
  );
}
