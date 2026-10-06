import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { LIFECYCLE_LABELS, type StatusEntity } from "@/lib/status-models";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listStatusChanges } from "@/server/services/status-models";

export const metadata = { title: "Status changes" };
export const dynamic = "force-dynamic";

const ENTITIES: { key: StatusEntity | "ALL"; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "SHOP", label: "Shops" },
  { key: "RIDER", label: "Riders" },
  { key: "SUBSCRIPTION", label: "Subscriptions" },
];

/** Lifecycle status log (F1): every shop, rider and subscription status change, newest first. */
export default async function StatusChangesPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string; id?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.AUDIT_LOG_VIEW) && !can(user.role, PERMISSIONS.AUDIT_LOG_VIEW_LIMITED)) redirect("/");
  const params = await searchParams;
  const entity = ENTITIES.some((e) => e.key === params.entity && e.key !== "ALL")
    ? (params.entity as StatusEntity)
    : undefined;
  const rows = await listStatusChanges({ entityType: entity, entityId: params.id, limit: 200 });

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Status changes"
        description="Lifecycle changes of shops, riders and subscriptions, with who made them. Recorded by the database for every change."
      />
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter">
        {ENTITIES.map((e) => (
          <Link
            key={e.key}
            href={e.key === "ALL" ? "/admin/status-changes" : `/admin/status-changes?entity=${e.key}`}
            className={(entity ?? "ALL") === e.key ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1 text-ink-700"}
          >
            {e.label}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <EmptyState title="No status changes recorded yet." />
      ) : (
        <Card className="divide-y divide-cream-100 text-sm" data-testid="status-changes">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
              <span className="flex items-center gap-2">
                <Badge tone="neutral">{r.entityType.toLowerCase()}</Badge>
                <Link href={`/admin/status-changes?entity=${r.entityType}&id=${r.entityId}`} className="font-mono text-xs text-ink-500 hover:underline">
                  {r.entityId.slice(0, 8)}
                </Link>
                <span>
                  {r.fromStatus ? LIFECYCLE_LABELS[r.fromStatus] ?? r.fromStatus : "—"} →{" "}
                  <strong>{LIFECYCLE_LABELS[r.toStatus] ?? r.toStatus}</strong>
                </span>
              </span>
              <span className="text-xs text-ink-500">
                {r.actorId ? `by ${r.actorId.slice(0, 8)}` : "system"} ·{" "}
                {r.createdAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
              </span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
