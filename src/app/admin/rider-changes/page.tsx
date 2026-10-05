import { redirect } from "next/navigation";

import { RiderChangeReviewQueue } from "@/components/rider-change-review-queue";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listPendingChangeRequests } from "@/server/services/rider-profile";

export const metadata = { title: "Rider profile changes" };
export const dynamic = "force-dynamic";

/** F2: riders' identity / bank changes waiting for approval. */
export default async function RiderChangesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.DELIVERY_PARTNER_MANAGE)) redirect("/");
  const rows = await listPendingChangeRequests(user);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="Rider profile changes"
        description="Identity and bank details riders asked to change. Nothing applies until you approve it."
      />
      <RiderChangeReviewQueue
        rows={rows.map((r) => ({
          id: r.id,
          riderName: r.riderName,
          riderMobile: r.riderMobile,
          masked: r.masked as Record<string, string>,
          createdAt: r.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
