import Link from "next/link";
import { redirect } from "next/navigation";

import { SellerVerificationPanel, type PanelDocument } from "@/components/seller-verification-panel";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getShopVerificationSummary } from "@/server/services/seller-verification";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Shop verification" };
export const dynamic = "force-dynamic";

/** Seller onboarding: legal verification of the owner's own shop(s). */
export default async function ShopVerificationPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const params = await searchParams;
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) {
    return (
      <>
        <PageHeader title="Shop verification" />
        <EmptyState title="You haven't registered a shop yet" />
      </>
    );
  }
  const shop = shops.find((s) => s.id === params.shop) ?? shops[0];
  const summary = await getShopVerificationSummary(shop.id, user);

  const documents: PanelDocument[] = summary.documents.map((d) => ({
    id: d.id,
    docType: d.docType,
    label: d.label,
    requirement: d.requirement,
    status: d.status,
    numberMasked: d.numberMasked,
    verifiedName: d.verifiedName,
    validUntil: d.validUntil,
    lastErrorCode: d.lastErrorCode,
    reviewNote: d.reviewNote,
    declaredNotRegistered: d.details.declaredNotRegistered === true,
    files: d.files.map((f) => ({ id: f.id, contentType: f.contentType, createdAt: f.createdAt.toISOString() })),
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={`Verification — ${shop.name}`}
        description="We check your business documents with the government records before your shop sells online. Numbers are stored encrypted; only the last few characters are ever shown."
        action={
          <Link href="/shop" className="text-sm font-medium text-kesari-600 hover:underline">
            ← Shop dashboard
          </Link>
        }
      />
      {shops.length > 1 ? (
        <nav className="flex flex-wrap gap-2 text-sm" aria-label="Your shops">
          {shops.map((s) => (
            <Link
              key={s.id}
              href={`/shop/verification?shop=${s.id}`}
              className={s.id === shop.id ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1 text-ink-700"}
            >
              {s.name}
            </Link>
          ))}
        </nav>
      ) : null}
      {summary.complete ? (
        <Alert tone="success" title="All required documents are verified.">
          Keep them up to date — we&apos;ll remind you 30 days before anything expires.
        </Alert>
      ) : (
        <Alert tone="info" title="Still needed">
          {summary.missing.map((t) => summary.documents.find((d) => d.docType === t)?.label).join(", ")}.
          {summary.isFoodBusiness ? " Your shop sells food, so an FSSAI licence or registration is required." : ""}
        </Alert>
      )}
      <SellerVerificationPanel shopId={shop.id} documents={documents} />
    </div>
  );
}
