import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { DocumentUploadPanel } from "@/components/document-upload-panel";
import { Alert, PageHeader } from "@/components/ui";
import { formatDisplayDate, todayIn } from "@/lib/dates";
import { toPanelItems } from "@/lib/document-panel-items";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { browserReadEnabled } from "@/server/kyc/document-reader";
import { getDocumentChecklist } from "@/server/services/document-uploads";
import { activeFssaiWaiver } from "@/server/services/fssai-waiver";

export const metadata = { title: "Upload documents for a shop" };
export const dynamic = "force-dynamic";

/**
 * Owner request, 21-Nov-2026: an owner who cannot upload a document (FSSAI licence, Shop Act,
 * any licence) sends it to GoKesari, and an admin or operator uploads it here for them. The same
 * panel and the same routes as the owner's "Upload your documents" page (requireShopAccess lets a
 * reviewer with SHOP_GST_PAN_VERIFY act on any shop); the upload is recorded under the reviewer's name.
 */
export default async function AdminShopDocumentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=/admin/shops/${id}/documents`);
  if (!can(user.role, PERMISSIONS.SHOP_GST_PAN_VERIFY)) redirect("/admin");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [shop] = await db.select().from(shops).where(eq(shops.id, id)).limit(1);
  if (!shop || shop.deletedAt) notFound();
  const [checklist, waiver] = await Promise.all([getDocumentChecklist(shop.id, user), activeFssaiWaiver(shop.id)]);
  const missingLabels = checklist.items.filter((i) => checklist.missing.includes(i.docType)).map((i) => i.label);

  return (
    <div className="mx-auto max-w-3xl space-y-6" data-testid="admin-shop-documents-page">
      <PageHeader
        title={`Upload documents for ${shop.name}`}
        description={`For a document ${shop.ownerName} sent to GoKesari (by e-mail, WhatsApp or by hand). Upload the file or a photo, check the details read from it, and click Verify & Approve. It goes through the same checks as the owner's own upload, and your name is recorded with it.`}
        action={
          <Link href="/admin/console/shops" className="text-sm font-medium text-kesari-600 hover:underline">
            ← Shop approvals
          </Link>
        }
      />
      {waiver ? (
        <Alert tone="warning" title="Approved without its FSSAI licence">
          The FSSAI licence is due by {formatDisplayDate(todayIn("Asia/Kolkata", waiver.dueAt))}. The shop is suspended automatically if a valid
          licence is still not on file then.
        </Alert>
      ) : null}
      {!checklist.enabled ? (
        <Alert tone="info" title="Document upload is switched off">
          Turn on Business rules → documentUpload to upload documents here.
        </Alert>
      ) : checklist.missing.length === 0 ? (
        <Alert tone="success">All required documents are uploaded.</Alert>
      ) : (
        <Alert tone="info" title="Still needed">
          {missingLabels.join(", ")}.
        </Alert>
      )}
      {checklist.fssaiRequired && !checklist.fssaiOnFile ? (
        <Alert tone="warning" title="FSSAI licence required">
          This shop sells food, so a valid FSSAI licence or registration is needed. An expired licence is not accepted.
        </Alert>
      ) : null}
      {checklist.enabled ? (
        <DocumentUploadPanel shopId={shop.id} items={toPanelItems(checklist)} browserOcr={browserReadEnabled()} onBehalfOf={shop.ownerName} />
      ) : null}
    </div>
  );
}
