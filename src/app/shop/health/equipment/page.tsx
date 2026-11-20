import Link from "next/link";
import { redirect } from "next/navigation";

import { EquipmentStoreBoard } from "@/components/health/equipment";
import { ComingSoon } from "@/components/health/page-shell";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";
import { equipmentStoreForPage } from "@/server/health/rentals";

export const metadata = { title: "Equipment rentals" };
export const dynamic = "force-dynamic";

/** The medical equipment store: listings (rent and / or sale) and the rentals board (live). */
export default async function ShopEquipmentPage({ searchParams }: { searchParams: Promise<{ shopId?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/shop/health/equipment");
  if (!(await healthEnabled())) return <ComingSoon title="Equipment rentals" />;
  const sp = await searchParams;
  const store = await equipmentStoreForPage(user, sp.shopId);
  if (!store) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Equipment rentals" />
        <Alert tone="info">
          Register a shop of type Medical Equipment Store (<Link href="/shop/register" className="font-bold underline">register</Link>), then list your equipment here.
        </Alert>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Equipment rentals"
        description={store.shopName}
        action={
          <Link href={`/shop/health/equipment/profile?shopId=${store.shopId}`} className="inline-flex min-h-11 items-center rounded-lg border-2 border-[var(--gk-line)] bg-white px-4 text-sm font-bold" data-testid="equipment-profile-link">
            Store profile
          </Link>
        }
      />
      <EquipmentStoreBoard shopId={store.shopId} />
    </div>
  );
}
