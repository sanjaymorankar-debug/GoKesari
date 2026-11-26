import Link from "next/link";
import { redirect } from "next/navigation";

import { RegistrationLicencesAdmin } from "@/components/admin/registration-licences-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { LICENCE_ENTRY_STATUSES, type LicenceEntryStatus } from "@/server/db/schema";
import { formatIstStamp } from "@/server/onboarding-v2/roles";
import { listRegistrationLicences } from "@/server/onboarding-v2/shop-flow";

export const metadata = { title: "Registration licences" };
export const dynamic = "force-dynamic";

/**
 * docs/onboarding-v2-2026-11 (Flow 2): the licences shop owners gave at registration (enter details, upload, scan, or
 * "upload later"), per shop. The queue of those waiting for GoKesari's team (approve / reject), and every promise
 * with its deadline (the existing document follow-up reminds on the 1st and 15th and suspends after it). IST times.
 */
export default async function RegistrationLicencesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_REGISTRATION_MANAGE)) redirect("/");
  const params = await searchParams;
  const status = ([...LICENCE_ENTRY_STATUSES, "ALL"] as const).find((s) => s === params.status) ?? "PENDING_OPERATOR";
  const shopId = typeof params.shop === "string" && /^[0-9a-f-]{36}$/i.test(params.shop) ? params.shop : null;
  const rows = await listRegistrationLicences({ status: status as LicenceEntryStatus | "ALL", shopId });
  const tabs: { key: string; label: string }[] = [
    { key: "PENDING_OPERATOR", label: "Waiting for the team" },
    { key: "PROMISED", label: "Upload later (promised)" },
    { key: "VERIFIED", label: "Verified" },
    { key: "REJECTED", label: "Rejected" },
    { key: "ALL", label: "All" },
  ];
  return (
    <div className="mx-auto max-w-5xl space-y-3">
      <PageHeader
        title="Registration licences"
        description="Licences shop owners gave while registering (onboarding v2): check the ones waiting for the team, and see every promise with its deadline. Times in IST."
      />
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/admin/shop-documents/registration-licences?status=${t.key}${shopId ? `&shop=${shopId}` : ""}`}
            className={`inline-flex min-h-11 items-center rounded-full border px-3 ${status === t.key ? "border-kesari-600 bg-kesari-600 text-white" : "border-[var(--gk-line)] bg-white text-ink-700"}`}
          >
            {t.label}
          </Link>
        ))}
        <Link href="/admin/shop-documents" className="inline-flex min-h-11 items-center px-2 text-kesari-700 underline">
          Document rules
        </Link>
      </nav>
      <RegistrationLicencesAdmin
        rows={rows.map((r) => ({
          ...r,
          updatedAtIst: formatIstStamp(r.updatedAt),
          promiseAcceptedAtIst: r.promiseAcceptedAt ? formatIstStamp(r.promiseAcceptedAt) : null,
          promiseDueAtIst: r.promiseDueAt ? formatIstStamp(r.promiseDueAt) : null,
        }))}
      />
    </div>
  );
}
