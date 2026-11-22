import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/ui";
import { CompareView } from "@/components/smart-list/compare-view";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getCustomerLocation } from "@/server/location";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { compareSavedWishlist, getWishlist } from "@/server/services/smart-list/wishlist";

export const metadata = { title: "Compare shop prices" };
export const dynamic = "force-dynamic";

export default async function CompareWishlistPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ pending?: string }> }) {
  const user = await getCurrentUser();
  const { id } = await params;
  if (!user) redirect(`/signin?next=/wishlist/${id}/compare`);
  if (!(await isFeatureEnabled("smart_list_scan_enabled"))) notFound();
  const list = await getWishlist(user.id, id).catch(() => null);
  if (!list) notFound();
  const [lang, location] = await Promise.all([getBoardLang(), getCustomerLocation(user.id)]);
  if (!location) {
    return (
      <>
        <PageHeader title="Compare shop prices" />
        <p className="rounded-xl bg-amber-50 p-4" data-testid="compare-no-location">
          Set your location (the location button at the top) so we can find shops near you, then come back.
        </p>
      </>
    );
  }
  const comparison = await compareSavedWishlist(user.id, id, location, (await searchParams).pending === "1");
  const itemNames = Object.fromEntries(list.items.map((i) => [i.id, i.nameLocal && lang !== "en" ? `${i.nameEn} · ${i.nameLocal}` : i.nameEn]));
  return (
    <>
      <PageHeader title={`Compare: ${list.name}`} description={`Shops within ${comparison.radiusKm} km of you, priced now.`} />
      <Link href={`/wishlist/${id}`} className="mb-3 inline-block text-sm font-semibold text-kesari-800 underline">
        ← Edit wishlist
      </Link>
      <CompareView lang={lang} wishlistId={id} comparison={comparison} itemNames={itemNames} />
    </>
  );
}
