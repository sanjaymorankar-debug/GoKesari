import { redirect } from "next/navigation";

import { PriceReferencesManager } from "@/components/price-references-manager";
import { Alert, PageHeader } from "@/components/ui";
import { PRICE_REFERENCES_DROPPED, PRICE_REFERENCES_DROPPED_NOTICE } from "@/lib/price-references-drop";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listReferenceQueue } from "@/server/services/price-references";

export const metadata = { title: "External reference prices" };
export const dynamic = "force-dynamic";

export default async function PriceReferencesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.PRICE_REFERENCE_MANAGE)) redirect("/");

  // batch-2026-10 WS-A: F1.4.3 (GS-023) dropped. The page stays reachable by its address
  // (no menu entry) and says so; the recorded references are kept, unused.
  if (PRICE_REFERENCES_DROPPED) {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="External reference prices" />
        <div data-testid="price-references-dropped">
          <Alert tone="warning" title="Feature dropped (F1.4.3)">
            {PRICE_REFERENCES_DROPPED_NOTICE} Reference prices are not shown to customers or shops, and nothing is fetched
            from other websites.
          </Alert>
        </div>
      </div>
    );
  }

  const { status } = await searchParams;
  const current = (["UNVERIFIED", "VERIFIED", "REJECTED"] as const).find((s) => s === status) ?? "UNVERIFIED";
  const queue = await listReferenceQueue(current);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="External reference prices"
        description="Prices seen outside Gokesari, recorded with their source and verified by operations. Shown to others only as the Settings rule allows."
      />
      <PriceReferencesManager
        status={current}
        queue={queue.map((q) => ({
          id: q.reference.id,
          productCode: q.productCode,
          productName: q.productName,
          pricePaise: q.reference.pricePaise,
          unitBasis: q.reference.unitBasis,
          sourceType: q.reference.sourceType,
          sourceName: q.reference.sourceName,
          referenceUrl: q.reference.referenceUrl,
          marketLocation: q.reference.marketLocation,
          referencedAt: q.reference.referencedAt,
          verificationStatus: q.reference.verificationStatus,
        }))}
      />
    </div>
  );
}
