import Link from "next/link";
import { redirect } from "next/navigation";

import { SocietyDecisionButtons } from "@/components/society-actions";
import { Card, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listSocietiesForReview } from "@/server/services/societies";

export const metadata = { title: "Societies" };
export const dynamic = "force-dynamic";

const STATUSES = ["APPLIED", "VERIFIED", "SUSPENDED", "REJECTED"] as const;

/** Operations: society verification queue and directory (GS-044). */
export default async function AdminSocietiesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SOCIETY_MANAGE_ANY)) redirect("/");
  const { status } = await searchParams;
  const current = (STATUSES as readonly string[]).includes(status ?? "") ? (status as (typeof STATUSES)[number]) : "APPLIED";
  const rows = await listSocietiesForReview(current);

  return (
    <>
      <PageHeader title="Societies" description="Verify new societies; suspend or reinstate existing ones." />
      <nav className="mb-4 flex flex-wrap gap-2 text-sm">
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/admin/societies?status=${s}`}
            className={`rounded-lg border px-3 py-1 ${s === current ? "border-kesari-400 bg-kesari-50" : "border-cream-200"}`}
          >
            {s.toLowerCase()}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <EmptyState title={`No ${current.toLowerCase()} societies.`} />
      ) : (
        <Card className="divide-y divide-cream-100">
          {rows.map(({ society: s, members }) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
              <div>
                <Link href={`/society/${s.id}`} className="font-medium text-ink-900 underline">
                  {s.name}
                </Link>
                <p className="text-xs text-ink-500">
                  {[s.addressLine1, s.area, s.city].filter(Boolean).join(", ")} {s.pincode} · {members} active members
                  {s.rejectionReason ? ` · ${s.rejectionReason}` : ""}
                </p>
              </div>
              <span className="flex items-center gap-2">
                <StatusBadge status={s.status} />
                <SocietyDecisionButtons societyId={s.id} status={s.status} />
              </span>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
