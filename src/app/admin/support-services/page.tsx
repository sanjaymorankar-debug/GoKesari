import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { SupportServicesAdmin } from "@/components/support-services-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getSupportSettings, listCharges, supportServicesReport } from "@/server/services/support-services";

export const metadata = { title: "Support services" };
export const dynamic = "force-dynamic";

/**
 * Support services administration (docs/dealer-programme, GKS-SP-001):
 * admin sets the charges and refund rule; admin and operator see every
 * request and the report. Off (flag) → not found.
 */
export default async function AdminSupportServicesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") redirect("/");
  if (!(await isFeatureEnabled("paid_support_services_enabled"))) notFound();
  const [charges, settings, report] = await Promise.all([listCharges(), getSupportSettings(), supportServicesReport()]);

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin/support" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Help desk
      </Link>
      <PageHeader title="Support services" description="Paid help for shops: product upload, price update and general support. Each paid request opens a help-desk ticket; work it there." />
      <SupportServicesAdmin
        isAdmin={user.role === "ADMIN"}
        charges={charges.map((c) => ({ ...c, createdAt: undefined }))}
        settings={{ refundPercentBeforeWork: settings.refundPercentBeforeWork, freeForManagedBilling: settings.freeForManagedBilling }}
        summary={report.summary}
        requests={report.requests.map((r) => ({
          id: r.id,
          receiptNumber: r.receiptNumber,
          shopName: r.shopName,
          serviceKey: r.serviceKey,
          quantity: r.quantity,
          totalPaise: r.totalPaise,
          refundPaise: r.refundPaise,
          status: r.status,
          paymentMethod: r.paymentMethod,
          ticketNumber: r.ticketNumber,
          ticketStatus: r.ticketStatus,
          createdAt: r.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
