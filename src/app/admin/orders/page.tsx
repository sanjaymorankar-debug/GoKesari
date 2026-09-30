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
  const [orders, shops] = await Promise.all([
    listOrdersForMonitoring(params),
    listShopOptions(),
  ]);

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
