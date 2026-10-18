import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { RiderNavigation } from "@/components/rider-navigation";
import { Alert, PageHeader } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { PERMISSIONS, can } from "@/server/authz/permissions";
import { getDeliveryNavigation, isRiderNavigationEnabled } from "@/server/services/rider-navigation";

export const metadata = { title: "Navigation" };
export const dynamic = "force-dynamic";

/**
 * F4.2.2 (batch-2026-10 WS-B): in-app turn-by-turn navigation for the rider's
 * delivery — to the shop, then to the customer. Rule riderNavigation; not
 * found while it is off. Only the rider holding the delivery.
 */
export default async function RiderNavigationPage({ params }: { params: Promise<{ deliveryId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!(await isRiderNavigationEnabled())) notFound();
  const { deliveryId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(deliveryId)) notFound();
  if (!can(user.role, PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN)) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Navigation" />
        <Alert tone="warning">Switch to your Delivery Partner role to navigate.</Alert>
      </div>
    );
  }

  let nav;
  try {
    nav = await getDeliveryNavigation(deliveryId, user.id);
  } catch (error) {
    if (error instanceof AppError && (error.code === "FORBIDDEN" || error.code === "NOT_FOUND")) notFound();
    const message = error instanceof AppError ? error.message : "Navigation could not be loaded.";
    return (
      <div className="mx-auto max-w-2xl space-y-3">
        <PageHeader title="Navigation" />
        <Alert tone="warning">{message}</Alert>
        <Link href="/delivery-partner" className="text-sm font-medium text-kesari-700 underline">
          Back to my delivery
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Navigation" />
      <RiderNavigation initial={nav} />
    </div>
  );
}
