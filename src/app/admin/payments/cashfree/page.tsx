import { redirect } from "next/navigation";

import { CashfreeAdminPanel } from "@/components/cashfree-admin-panel";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { cashfreeHealth, listCashfreeLiveTests } from "@/server/payments/cashfree-health";

export const metadata = { title: "Cashfree set-up & tests" };
export const dynamic = "force-dynamic";

/**
 * Finance: how Cashfree is set up on this site, Cashfree's own list of the
 * payment methods switched on for the account, and the ₹1 payment test
 * (paid in Cashfree's checkout, refunded at once). docs/payments-cashfree-audit-2026-11.
 */
export default async function AdminCashfreePage({ searchParams }: { searchParams: Promise<{ test?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.FINANCE_VIEW)) redirect("/");
  const params = await searchParams;
  const [health, tests] = await Promise.all([cashfreeHealth(user), listCashfreeLiveTests(user)]);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Cashfree set-up & tests"
        description="Which Cashfree environment this site uses, the URLs Cashfree calls, the payment methods Cashfree has switched on, and a ₹1 test payment that is refunded at once. Keys are never shown."
      />
      <CashfreeAdminPanel
        initialHealth={health}
        initialTests={tests}
        canManage={can(user.role, PERMISSIONS.FINANCE_MANAGE)}
        returnedOrderId={params.test && /^gktest_[A-Za-z0-9_]+$/.test(params.test) ? params.test : null}
      />
    </div>
  );
}
