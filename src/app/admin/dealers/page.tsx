import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Badge, PageHeader } from "@/components/ui";
import { DEALER_STATUS_LABELS, DEALER_STATUSES, DEALER_TYPE_LABELS, type DealerStatus } from "@/lib/dealers";
import { getCurrentUser } from "@/server/authz/guards";
import { DocRequirementsAdmin } from "@/components/dealer/doc-requirements-admin";
import { dealersOverview } from "@/server/dealers/performance";
import { listDealers, listDocumentRequirements } from "@/server/dealers/service";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Dealers" };
export const dynamic = "force-dynamic";

const TONE: Record<DealerStatus, "neutral" | "success" | "warning" | "danger" | "info"> = {
  DRAFT: "neutral",
  PENDING: "warning",
  APPROVED: "success",
  SUSPENDED: "danger",
  REJECTED: "neutral",
  TERMINATED: "neutral",
};

/**
 * Dealers and the approval queue (docs/dealer-programme, GKS-DR-002). Admin
 * decides; operators read. Not there while the programme is off.
 */
export default async function AdminDealersPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") redirect("/");
  const params = await searchParams;
  const status = (DEALER_STATUSES as readonly string[]).includes(params.status ?? "") ? (params.status as DealerStatus) : "PENDING";
  const [rows, overview, requirements] = await Promise.all([listDealers({ status, q: params.q?.slice(0, 80) }), dealersOverview(), listDocumentRequirements()]);
  const stats = new Map(overview.map((o) => [o.id, o]));
  // Approved / all: highest rating first (the rating list across dealers).
  if (status === "APPROVED" || (params.status ?? "") === "ALL") rows.sort((x, y) => (stats.get(y.id)?.rating ?? 0) - (stats.get(x.id)?.rating ?? 0));
  const filters: (DealerStatus | "ALL")[] = ["PENDING", "APPROVED", "SUSPENDED", "REJECTED", "TERMINATED", "DRAFT", "ALL"];

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <Link href={user.role === "ADMIN" ? "/admin/menu/shops" : "/admin/menu/onboarding"} className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Shops
      </Link>
      <PageHeader title="Dealers" description="Applications waiting for approval, and every dealer. Only an admin approves, rejects, suspends or terminates; every decision is logged." />
      <p className="mb-3 text-sm">
        <Link className="font-semibold text-kesari-800 underline" href="/admin/dealers/commission">Commission, rating & payouts</Link> ·{" "}
        <Link className="font-semibold text-kesari-800 underline" href="/admin/dealers/claims">Attribution claims</Link> — dealers who say a shop is theirs.
      </p>
      <nav className="mb-3 flex flex-wrap gap-2" aria-label="Filter by status">
        {filters.map((f) => (
          <Link
            key={f}
            href={`/admin/dealers?status=${f}`}
            className={`inline-flex min-h-11 items-center rounded-full border px-3 text-sm ${f === (params.status ?? "PENDING") ? "border-kesari-700 bg-kesari-700 text-white" : "border-cream-200 bg-white text-ink-700"}`}
          >
            {f === "ALL" ? "All" : DEALER_STATUS_LABELS[f]}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-600">No dealers here.</p>
      ) : (
        <ul className="divide-y divide-cream-200 rounded-2xl border-2 border-[var(--gk-line)] bg-white" data-testid="dealer-list">
          {rows.map((d) => (
            <li key={d.id}>
              <Link href={`/admin/dealers/${d.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-cream-50">
                <span>
                  <span className="font-semibold text-ink-900">{d.legalName}</span>{" "}
                  <span className="text-sm text-ink-600">
                    {d.contactName} · {DEALER_TYPE_LABELS[d.dealerType]}
                    {d.city ? ` · ${d.city}` : ""}
                    {d.isInternal ? " · internal" : d.source === "LEGACY_MIGRATION" ? " · former distributor" : ""}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2 text-sm text-ink-700">
                  {stats.get(d.id) && !d.isInternal && d.status !== "DRAFT" && d.status !== "PENDING" ? (
                    <span data-testid="dealer-stats">
                      ★ {stats.get(d.id)!.rating.toFixed(1)} · {stats.get(d.id)!.registeredShops} shops ({stats.get(d.id)!.activatedShops} live) · ₹
                      {(stats.get(d.id)!.earnedPaise / 100).toLocaleString("en-IN")} earned
                    </span>
                  ) : null}
                  <Badge tone={TONE[d.status]}>{d.statusLabel}</Badge>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6">
        <DocRequirementsAdmin isAdmin={user.role === "ADMIN"} requirements={requirements} />
      </div>
    </div>
  );
}
