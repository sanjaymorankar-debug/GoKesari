import Link from "next/link";
import { redirect } from "next/navigation";

import { EquipmentStoreProfileForm } from "@/components/health/equipment";
import { ComingSoon } from "@/components/health/page-shell";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { healthEquipmentStoreProfiles } from "@/server/db/schema";
import { healthEnabled } from "@/server/health/access";
import { equipmentStoreForPage } from "@/server/health/rentals";
import { eq } from "drizzle-orm";

export const metadata = { title: "Equipment store profile" };
export const dynamic = "force-dynamic";

/** The store's rental terms, damage policy and delivery radius; GoKesari's verification status. */
export default async function EquipmentStoreProfilePage({ searchParams }: { searchParams: Promise<{ shopId?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/shop/health/equipment/profile");
  if (!(await healthEnabled())) return <ComingSoon title="Equipment store profile" />;
  const sp = await searchParams;
  const store = await equipmentStoreForPage(user, sp.shopId);
  const [profile] = store ? await db.select().from(healthEquipmentStoreProfiles).where(eq(healthEquipmentStoreProfiles.shopId, store.shopId)) : [];
  return (
    <div className="mx-auto max-w-3xl">
      <Link href={`/shop/health/equipment${store ? `?shopId=${store.shopId}` : ""}`} className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Equipment rentals
      </Link>
      <PageHeader title="Store profile" description={store?.shopName} />
      {store ? <EquipmentStoreProfileForm shopId={store.shopId} profile={profile ?? null} /> : <Alert tone="info">Register a Medical Equipment Store first.</Alert>}
    </div>
  );
}
