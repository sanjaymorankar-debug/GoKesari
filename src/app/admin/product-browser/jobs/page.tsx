import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listJobs } from "@/server/pmd/ingest-jobs";

export const metadata = { title: "Product imports" };
export const dynamic = "force-dynamic";

/** F9.1.4 — every product-data import (manufacturer uploads, API, GS1 / Open Food Facts look-ups) with progress. */
export default async function JobsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.PMD_VIEW)) redirect("/");
  const jobs = await listJobs({ limit: 100 });
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-3 py-4">
      <PageHeader title="Product imports" description="Large files are loaded in batches by the import worker and resume after an interruption." />
      {jobs.length === 0 ? (
        <EmptyState title="No imports yet" />
      ) : (
        <ul className="space-y-2">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link href={`/admin/product-browser/jobs/${j.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-xl border border-cream-200 bg-white p-3">
                <span>
                  <span className="block font-semibold text-ink-900">{j.fileName ?? j.kind}</span>
                  <span className="block text-xs text-ink-500">
                    {j.kind.replace(/_/g, " ").toLowerCase()} · {j.sourceKey} · {j.stagedRows}/{j.validRows} staged · {j.invalidRows + j.failedRows} need attention
                  </span>
                </span>
                <Badge tone={j.status === "SUCCEEDED" ? "success" : j.status === "FAILED" ? "danger" : "info"}>{`${j.status} ${j.percent}%`}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
