import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listJobs } from "@/server/pmd/ingest-jobs";
import { manufacturerAccountsForUser } from "@/server/pmd/manufacturers";

export const metadata = { title: "My imports" };
export const dynamic = "force-dynamic";

export default async function ManufacturerJobsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const [account] = await manufacturerAccountsForUser(user.id);
  if (!account) redirect("/manufacturer");
  const jobs = await listJobs({ manufacturerAccountId: account.id });
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-4">
      <PageHeader title="My imports" description={account.name} />
      {jobs.length === 0 ? (
        <EmptyState title="No uploads yet" />
      ) : (
        <ul className="space-y-2">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link href={`/manufacturer/jobs/${j.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-xl border border-cream-200 bg-white p-3">
                <span>
                  <span className="block font-semibold text-ink-900">{j.fileName ?? "Upload"}</span>
                  <span className="block text-xs text-ink-500">{j.stagedRows}/{j.totalRows} staged · {j.invalidRows + j.failedRows} need attention</span>
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
