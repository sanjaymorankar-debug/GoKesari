import { redirect } from "next/navigation";

import { RiderKycReviewQueue } from "@/components/rider-kyc-review-queue";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listRiderDocumentsForAdmin } from "@/server/services/rider-files";

export const metadata = { title: "Rider identity documents" };
export const dynamic = "force-dynamic";

/** C5: rider identity documents — admins only (operators are redirected). Every file opening is audited. */
export default async function RiderKycPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN") redirect("/");
  const documents = await listRiderDocumentsForAdmin(user);
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Rider identity documents"
        description="Documents riders uploaded. Only admins can open them, and each opening is recorded in the audit log."
      />
      <RiderKycReviewQueue
        documents={documents.map((d) => ({
          id: d.id,
          label: d.label,
          status: d.status,
          rejectionReason: d.rejectionReason,
          createdAt: d.createdAt.toISOString(),
          riderName: d.riderName,
          riderMobile: d.riderMobile,
          riderStatus: d.riderStatus,
          riderId: d.riderId,
          fileUrl: d.fileUrl,
        }))}
      />
    </div>
  );
}
