import { redirect } from "next/navigation";

import { SellerVerificationReviewQueue, type QueueItem } from "@/components/seller-verification-review-queue";
import { PageHeader } from "@/components/ui";
import { SELLER_DOC_LABELS } from "@/lib/kyc/doc-formats";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listVerificationReviewQueue } from "@/server/services/seller-verification";

export const metadata = { title: "Seller verification review" };
export const dynamic = "force-dynamic";

/** Seller documents the automatic checks could not settle — oldest first. */
export default async function SellerVerificationReviewPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_GST_PAN_VERIFY)) redirect("/");
  const queue = await listVerificationReviewQueue(user);

  const items: QueueItem[] = queue.map((q) => ({
    id: q.view.id!,
    shopId: q.shopId,
    shopName: q.shopName,
    city: q.city,
    ownerName: q.ownerName,
    legalBusinessName: q.legalBusinessName,
    pincode: q.pincode,
    docType: q.view.docType,
    docLabel: SELLER_DOC_LABELS[q.view.docType],
    status: q.view.status,
    numberMasked: q.view.numberMasked,
    verifiedName: q.view.verifiedName,
    nameMatchScore: q.view.nameMatchScore,
    validUntil: q.view.validUntil,
    lastErrorCode: q.view.lastErrorCode,
    details: q.view.details,
    attemptCount: q.view.attemptCount,
    files: q.files,
    updatedAt: q.updatedAt.toISOString(),
  }));

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Seller verification review"
        description="Documents the automatic checks couldn't settle: name or address mismatches, Shop Act certificates no vendor can check, GST declarations, and checks paused by a vendor problem. Compare, then approve or reject with a reason the seller will see."
      />
      <SellerVerificationReviewQueue items={items} />
    </div>
  );
}
