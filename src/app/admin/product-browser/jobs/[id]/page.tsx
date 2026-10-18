import { notFound, redirect } from "next/navigation";

import { JobProgressView } from "@/components/batch-d/job-progress";
import { PageHeader } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { jobProgress } from "@/server/pmd/ingest-jobs";

export const metadata = { title: "Import progress" };
export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.PMD_VIEW)) redirect("/");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  let progress: Awaited<ReturnType<typeof jobProgress>>;
  try {
    progress = await jobProgress(id);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-4">
      <PageHeader title="Import progress" />
      <JobProgressView initial={JSON.parse(JSON.stringify(progress))} canResume={can(user.role, PERMISSIONS.PMD_IMPORT)} />
    </div>
  );
}
