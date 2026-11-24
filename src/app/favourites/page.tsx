import { notFound } from "next/navigation";

import { FavouritesList } from "@/components/favourites/favourites-list";
import { PageHeader } from "@/components/ui";
import { tr } from "@/lib/board/i18n";
import { BBF } from "@/lib/brand-barcode-favourites-i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getCustomerLocation } from "@/server/location";
import { describeFavourites } from "@/server/services/favourites";
import { favouritesOn } from "@/server/services/favourites-flag";
import { serviceableShopIds } from "@/server/services/serviceability";

export const metadata = { title: "Favourites" };
export const dynamic = "force-dynamic";

/**
 * Favourites (docs/search-brand-barcode-favourites-2026-11): products saved with the heart, with the
 * lowest price near the customer and "Add to cart". Signed in: the account's list. Guest: the list kept
 * in this browser (read on the page). Not found while the flag brand_barcode_favourites_enabled is off.
 */
export default async function FavouritesPage() {
  if (!(await favouritesOn())) notFound();
  const [user, lang] = await Promise.all([getCurrentUser(), getBoardLang()]);
  let items = null;
  if (user) {
    const location = await getCustomerLocation(user.id).catch(() => null);
    const nearby = location ? await serviceableShopIds(location).catch(() => null) : null;
    items = await describeFavourites({ userId: user.id }, { shopIds: nearby ? [...nearby.keys()] : undefined });
  }
  return (
    <>
      <PageHeader title={tr(BBF.favourites, lang)} description={tr(BBF.favouritesIntro, lang)} />
      <FavouritesList lang={lang} signedIn={Boolean(user)} initialItems={items} />
    </>
  );
}
