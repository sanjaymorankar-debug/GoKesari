import { redirect } from "next/navigation";

import { AgreementsSigner } from "@/components/agreements/agreements-signer";
import { EmptyState, PageHeader } from "@/components/ui";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "My Agreements" };
export const dynamic = "force-dynamic";

/**
 * My Agreements (docs/seller-agreements-2026-11): sign the shop's personalised Seller SLA (and, for medical
 * shops, the Merchant Onboarding Agreement), and download the signed copies with their Verify links.
 */
export default async function MyAgreementsPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) {
    return (
      <>
        <PageHeader title="My Agreements" />
        <EmptyState title="You haven't registered a shop yet" />
      </>
    );
  }
  const shop = await activeShop(shops, (await searchParams).shop);
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title={`My Agreements — ${shop.name}`}
        description="Your agreements with gokesari.com, prepared from your shop's own details and licences, in English, मराठी and हिंदी."
      />
      <AgreementsSigner apiBase={`/api/shops/${shop.id}/agreements`} />
    </div>
  );
}
