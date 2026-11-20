import Link from "next/link";
import { redirect } from "next/navigation";

import { ConsultAdmin } from "@/components/consult/admin";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { consultEnabled } from "@/server/consult/access";

export const metadata = { title: "Consultants" };
export const dynamic = "force-dynamic";

/**
 * Consultant appointments for admins and operators (docs/consult-booking-2026-11): verification, bookings,
 * categories with commission, policy templates and reports. Works while the rule is off, so staff can
 * prepare categories and verify profiles before launch.
 */
export default async function AdminConsultPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.CONSULT_MANAGE)) redirect("/");
  const on = await consultEnabled();
  const wanted = (await searchParams).tab;
  const tab = (["verify", "bookings", "categories", "policies", "reports"] as const).find((t) => t === wanted) ?? "verify";
  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/admin" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Admin
      </Link>
      <PageHeader title="Consultants" description="Doctors, advocates, CAs and other professionals who take bookings: verification, bookings, refunds, disputes, categories, commission and reports." />
      {!on ? (
        <div className="mb-3">
          <Alert tone="warning">
            Customers cannot see consultant bookings yet: rule <strong>consultBooking</strong> is off (<Link href="/admin/settings" className="underline">Admin → Settings</Link>).
          </Alert>
        </div>
      ) : null}
      <ConsultAdmin initialTab={tab} />
    </div>
  );
}
