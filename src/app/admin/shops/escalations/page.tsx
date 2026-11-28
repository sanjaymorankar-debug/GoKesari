import Link from "next/link";
import { redirect } from "next/navigation";

import { ReviewFlagsTable, SupportEscalationsTable } from "@/components/admin/support-escalations-table";
import { EmptyState, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { SUPPORT_ESCALATION_LEVELS, type SupportEscalationLevel } from "@/server/db/schema";
import { countOpenEscalations, escalationTableRows, listEscalations, listOpenReviewFlags, reviewFlagTableRows } from "@/server/services/support-escalations";

export const metadata = { title: "Escalations" };
export const dynamic = "force-dynamic";

const LABEL: Record<SupportEscalationLevel | "ALL" | "CLOSED", string> = {
  OPERATOR: "Operator queue",
  ADMIN: "Admin team",
  FRANCHISEE: "With the franchisee",
  ALL: "All open",
  CLOSED: "Closed",
};

/**
 * 0232 (owner, 28-Nov-2026): the escalation ladder — franchisee first, the operator queue after 7 days, the admin team
 * after 10. Held v2 / v3 shops (duplicate GSTIN / PAN of another owner), pay-later requests and shops not selling 10
 * days after go-live; the review flags of shops that went live with a weak name match. Admin and operator.
 */
export default async function EscalationsPage({ searchParams }: { searchParams: Promise<{ level?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_APPROVE)) redirect("/");
  const p = await searchParams;
  const tab = ([...SUPPORT_ESCALATION_LEVELS, "ALL", "CLOSED"] as string[]).includes(p.level ?? "") ? (p.level as SupportEscalationLevel | "ALL" | "CLOSED") : user.role === "ADMIN" ? "ADMIN" : "OPERATOR";
  const [views, counts, flags] = await Promise.all([
    listEscalations(tab === "CLOSED" ? { open: false, limit: 200 } : { level: tab }),
    countOpenEscalations(),
    listOpenReviewFlags(),
  ]);
  const rows = escalationTableRows(tab === "CLOSED" ? views.filter((v) => v.resolvedAt !== null) : views, { id: user.id, role: user.role });
  const tabs: (SupportEscalationLevel | "ALL" | "CLOSED")[] = ["OPERATOR", "ADMIN", "FRANCHISEE", "ALL", "CLOSED"];
  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <PageHeader
        title="Escalations"
        description="Shops held for review (another owner's shop has the same GSTIN or PAN), pay-later requests and shops that have not started selling 10 days after going live. Each starts with the franchisee behind the shop's referral code (or here, when there is none), moves to the operator queue after 7 days and to the admin team after 10 (rule supportEscalation). Times in IST."
      />
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter">
        {tabs.map((t) => (
          <Link key={t} href={`/admin/shops/escalations?level=${t}`} className={`rounded-full border px-3 py-1 ${t === tab ? "border-ink-900 bg-ink-900 text-white" : "border-ink-300 text-ink-700"}`}>
            {LABEL[t]}
            {t === "ALL" ? ` (${counts.total})` : t === "CLOSED" ? "" : ` (${counts[t]})`}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? <EmptyState title="Nothing here" description="No item for this filter." /> : <SupportEscalationsTable rows={rows} apiPath="/api/admin/support-escalations" />}
      <section className="space-y-2" aria-labelledby="review-flags">
        <h2 id="review-flags" className="text-base font-semibold text-ink-900">
          To check after go-live ({flags.length})
        </h2>
        <p className="text-sm text-ink-600">
          Shops that went live on a verified GST / PAN number whose name did not match well, or whose PAN is not the one inside the GSTIN. Not a hold — check and mark them.
        </p>
        {flags.length === 0 ? <EmptyState title="Nothing to check" description="No open review flag." /> : <ReviewFlagsTable rows={reviewFlagTableRows(flags)} />}
      </section>
    </div>
  );
}
