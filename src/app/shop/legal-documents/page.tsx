import Link from "next/link";
import { redirect } from "next/navigation";

import { LegalDocumentsPanel } from "@/components/legal-documents-panel";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getShopLegalStatus } from "@/server/services/legal-documents";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Legal documents" };
export const dynamic = "force-dynamic";

/** Legal Documents section: the licences this shop must hold (docs/four-features-2026-10, feature 2). */
export default async function ShopLegalDocumentsPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) {
    return (
      <>
        <PageHeader title="Legal documents" />
        <EmptyState title="You haven't registered a shop yet" />
      </>
    );
  }
  const params = await searchParams;
  const shop = shops.find((s) => s.id === params.shop) ?? shops[0];
  const status = await getShopLegalStatus(shop.id);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title={`Legal documents — ${shop.name}`}
        description="Licences your shop must hold for what it sells. Numbers are stored encrypted and only the last characters are shown."
        action={
          <Link href="/shop/verification" className="text-sm font-medium text-kesari-600 hover:underline">
            Business verification →
          </Link>
        }
      />
      {shops.length > 1 ? (
        <nav className="flex flex-wrap gap-2 text-sm" aria-label="Your shops">
          {shops.map((s) => (
            <Link
              key={s.id}
              href={`/shop/legal-documents?shop=${s.id}`}
              className={s.id === shop.id ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1 text-ink-700"}
            >
              {s.name}
            </Link>
          ))}
        </nav>
      ) : null}
      {!status.enabled ? (
        <Alert tone="info">Licence uploads are not switched on yet.</Alert>
      ) : status.documents.length === 0 ? (
        <Alert tone="success" title="Nothing needed">Your shop&apos;s categories do not need an FSSAI licence, drug licence or medical registration.</Alert>
      ) : (
        <>
          {status.restricted ? (
            <Alert tone="danger" title="Your shop cannot accept orders">Upload the documents marked below to start taking orders again.</Alert>
          ) : null}
          <LegalDocumentsPanel shopId={shop.id} documents={status.documents} />
        </>
      )}
    </div>
  );
}
