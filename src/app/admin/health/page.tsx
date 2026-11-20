import Link from "next/link";
import { redirect } from "next/navigation";

import { HealthAdmin } from "@/components/health/admin";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { consultEnabled } from "@/server/consult/access";
import { healthAdminTabs } from "@/server/health/admin";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "GoKesari Health" };
export const dynamic = "force-dynamic";

/**
 * GoKesari Health for admins and operators (docs/health/; owner brief §6, §7): provider verification,
 * drug master, care and equipment lists, Prime plans, settings, reports, access and audit logs,
 * break-glass (admins) and DPDP data requests. Metadata only — staff never see clinical details except
 * through a logged break-glass open. Works while the rule is off, so staff can verify providers and
 * prepare the lists before launch.
 */
export default async function AdminHealthPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.HEALTH_MANAGE)) {
    return (
      <div className="mx-auto max-w-xl py-10" data-testid="health-admin-forbidden">
        <PageHeader title="Not allowed (403)" description="GoKesari Health administration is for GoKesari administrators and operators." />
        <Link href="/" className="inline-flex min-h-11 items-center font-semibold text-kesari-800 hover:underline">
          ← Home
        </Link>
      </div>
    );
  }
  const tabs = healthAdminTabs(user);
  const [rule, consultOn] = await Promise.all([getRule("health"), consultEnabled()]);
  const wanted = (await searchParams).tab;
  const tab = tabs.find((t) => t === wanted) ?? "verify";
  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/admin" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Admin
      </Link>
      <PageHeader title="GoKesari Health" description="Verify doctors, home-care providers and stores; keep the medicine and equipment lists; reports, access logs and privacy requests. No clinical details are shown here." />
      {!rule.enabled || !consultOn ? (
        <div className="mb-3">
          <Alert tone="warning">
            Patients cannot use GoKesari Health yet: {!rule.enabled ? <strong>health</strong> : null}
            {!rule.enabled && !consultOn ? " and " : null}
            {!consultOn ? <strong>consultBooking</strong> : null} {!rule.enabled && !consultOn ? "are" : "is"} off
            {user.role === "ADMIN" ? (
              <>
                {" "}
                (<Link href="/admin/settings?rule=health" className="underline">
                  Admin → Settings
                </Link>
                )
              </>
            ) : null}
            .
          </Alert>
        </div>
      ) : null}
      <HealthAdmin tabs={tabs} initialTab={tab} breakGlassEnabled={rule.breakGlassEnabled} />
    </div>
  );
}
