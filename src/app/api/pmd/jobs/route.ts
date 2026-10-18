/** GET — every product-data import with progress (staff, PMD_VIEW) (batch-2026-10 WS-D, F9.1.4). */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listJobs } from "@/server/pmd/ingest-jobs";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.PMD_VIEW);
  return ok({ jobs: await listJobs({ limit: 100 }) });
});
