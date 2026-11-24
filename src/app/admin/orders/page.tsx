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
import { deliveryGpsForOrders, proofPhotosForOrders, signaturesForOrders } from "@/server/services/delivery-proofs";
import { invoiceKindsForOrders, orderInvoiceLabel } from "@/server/services/invoices";
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
  const deliveredIds = rawOrders.filter((o) => o.status === "DELIVERED").map((o) => o.id);
  // QA D-121: the link names the document issued (a shop outside GST issues a bill of supply).
  // Module 4: the customer's signature, and (operations only) where the rider delivered or failed the drop.
  const gpsIds = rawOrders.filter((o) => o.status === "DELIVERED" || o.status === "FAILED").map((o) => o.id);
  const [proofPhotos, invoiceKinds, signatures, gps] = await Promise.all([
    proofPhotosForOrders(deliveredIds),
    invoiceKindsForOrders(deliveredIds),
    signaturesForOrders(deliveredIds),
    deliveryGpsForOrders(gpsIds),
  ]);
  const orders = rawOrders.map((o) => ({
    ...o,
    proofPhotoUrl: proofPhotos.get(o.id)?.url ?? null,
    proofPhotoAt: proofPhotos.get(o.id)?.takenAt.toISOString() ?? null,
    signatureUrl: signatures.get(o.id)?.url ?? null,
    signatureAt: signatures.get(o.id)?.takenAt.toISOString() ?? null,
    signerName: signatures.get(o.id)?.signerName ?? null,
    deliveryGps: gps.get(o.id) ?? null,
    invoiceUrl: o.status === "DELIVERED" && invoicingRule.enabled ? `/api/orders/${o.id}/invoice` : null,
    invoiceLabel: orderInvoiceLabel(invoiceKinds.get(o.id)),
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
