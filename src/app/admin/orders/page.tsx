import { redirect } from "next/navigation";
import { Suspense } from "react";

import { PageHeader, Section } from "@/components/ui";
import { OrderFilters } from "@/components/order-filters";
import { OrderMonitoringTable } from "@/components/order-monitoring-table";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import {
  listOrdersForMonitoring,
  listShopOptions,
  orderStatusOptions,
} from "@/server/services/orders";
import { proofPhotosForOrders } from "@/server/services/delivery-proofs";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Order Monitoring" };
export const dynamic = "force-dynamic";

export default async function OrdersMonitoringPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; shopId?: string; dateFrom?: string; dateTo?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user || !can(user.role, PERMISSIONS.ORDER_VIEW_ANY)) {
    redirect("/signin");
  }

  const params = await searchParams;
  const [rawOrders, shops, invoicingRule] = await Promise.all([
    listOrdersForMonitoring(params),
    listShopOptions(),
    getRule("invoicing"),
  ]);
  // NEW-007: delivery photo and invoice links for delivered orders.
  const proofPhotos = await proofPhotosForOrders(rawOrders.filter((o) => o.status === "DELIVERED").map((o) => o.id));
  const orders = rawOrders.map((o) => ({
    ...o,
    proofPhotoUrl: proofPhotos.get(o.id)?.url ?? null,
    invoiceUrl: o.status === "DELIVERED" && invoicingRule.enabled ? `/api/orders/${o.id}/invoice` : null,
  }));

  return (
    <div className="space-y-8 pb-10">
      <PageHeader title="Order Monitoring" description="Track and intervene on marketplace orders" />

      <Section title="Filters">
        <Suspense>
          <OrderFilters shopOptions={shops} statusOptions={orderStatusOptions()} />
        </Suspense>
      </Section>

      <Section title={`Orders (${orders.length}${orders.length === 100 ? "+" : ""})`}>
        <OrderMonitoringTable
          orders={orders}
          canReassign={can(user.role, PERMISSIONS.DELIVERY_ORDER_MANAGE_ANY)}
        />
      </Section>
    </div>
  );
}
