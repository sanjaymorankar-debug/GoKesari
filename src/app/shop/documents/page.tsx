import Link from "next/link";
import { redirect } from "next/navigation";

import { DocumentUploadPanel } from "@/components/document-upload-panel";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { toPanelItems } from "@/lib/document-panel-items";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { browserReadEnabled } from "@/server/kyc/document-reader";
import { getDocumentChecklist } from "@/server/services/document-uploads";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Upload your documents" };
export const dynamic = "force-dynamic";

/**
 * Shop registration, documents step (docs/document-upload-2026-10): upload a
 * file or take a photo of each mandatory document; the details are read
 * automatically and the owner reviews them before submitting.
 */
export default async function ShopDocumentsPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/shop/documents");
  const params = await searchParams;
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) {
    return (
      <>
        <PageHeader title="Upload your documents" />
        <EmptyState title="You haven't registered a shop yet" />
      </>
    );
  }
  const shop = await activeShop(shops, params.shop);
  const checklist = await getDocumentChecklist(shop.id, user);

  const items = toPanelItems(checklist);
  const missingLabels = checklist.items.filter((i) => checklist.missing.includes(i.docType)).map((i) => i.label);

  return (
    <div className="mx-auto max-w-3xl space-y-6" data-testid="shop-documents-page">
      <PageHeader
        title={`Upload your documents — ${shop.name}`}
        description="Scan any document, or upload a file or take a photo on its card. We read the number, name, address and validity for you — you only check them and click Verify & Approve. Files are stored encrypted; only our verification team can open them."
        action={
          <Link href="/shop/verification" className="text-sm font-medium text-kesari-600 hover:underline">
            Verification status →
          </Link>
        }
      />
      {shops.length > 1 ? (
        <nav className="flex flex-wrap gap-2 text-sm" aria-label="Your shops">
          {shops.map((s) => (
            <Link
              key={s.id}
              href={`/shop/documents?shop=${s.id}`}
              className={s.id === shop.id ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1 text-ink-700"}
            >
              {s.name}
            </Link>
          ))}
        </nav>
      ) : null}
      {!checklist.enabled ? (
        <Alert tone="info" title="Document upload is switched off">
          Enter your document numbers on the <Link className="underline" href="/shop/verification">Verification</Link> page instead.
        </Alert>
      ) : checklist.missing.length === 0 ? (
        <Alert tone="success" title="All required documents are uploaded.">
          We&apos;ll remind you before anything expires.
        </Alert>
      ) : (
        <Alert tone="info" title="Still needed">
          {missingLabels.join(", ")}.
        </Alert>
      )}
      {checklist.fssaiRequired && !checklist.fssaiOnFile ? (
        <div data-testid="fssai-required">
        <Alert tone="warning" title="FSSAI licence required">
          Your shop sells food, so a valid FSSAI licence or registration is required by law. Registration can&apos;t be completed without it, and an
          expired licence is not accepted.
        </Alert>
        </div>
      ) : null}
      {checklist.enabled ? <DocumentUploadPanel shopId={shop.id} items={items} browserOcr={browserReadEnabled()} /> : null}
    </div>
  );
}
