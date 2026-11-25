import { redirect } from "next/navigation";

import { PhotoCatalogue } from "@/components/photo-catalogue";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { needsPhoto, needsPrice } from "@/lib/photo-catalogue";
import { L, tr } from "@/lib/board/i18n";
import { getBoardLang } from "@/server/board-lang";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { listShopPhotoCatalogue } from "@/server/services/product-images";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Photo catalogue" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Photo catalogue", "फ़ोटो कैटलॉग", "फोटो कॅटलॉग"),
  emptyDesc: L("{shop} — your products, each with its photo and price.", "{shop} — आपके उत्पाद, हर एक अपनी फ़ोटो और कीमत के साथ।", "{shop} — तुमची उत्पादने, प्रत्येक फोटो आणि किमतीसह."),
  desc: L(
    "{shop} — {withPhoto} of {total} products have a photo{noPrice}. Customers see the same photo and price on your shop page.",
    "{shop} — {total} में से {withPhoto} उत्पादों की फ़ोटो है{noPrice}। ग्राहक आपकी दुकान के पेज पर यही फ़ोटो और कीमत देखते हैं।",
    "{shop} — {total} पैकी {withPhoto} उत्पादनांचा फोटो आहे{noPrice}. ग्राहकांना तुमच्या दुकानाच्या पानावर हाच फोटो आणि किंमत दिसते.",
  ),
  noPrice: L(", {n} still need a price", ", {n} की कीमत अभी बाकी है", ", {n} ची किंमत अजून बाकी आहे"),
  viewShop: L("View my shop page", "मेरी दुकान का पेज देखें", "माझ्या दुकानाचे पान पहा"),
  bulk: L("Bulk photos & descriptions", "एक साथ फ़ोटो और विवरण", "एकत्र फोटो आणि वर्णन"),
  staff: L("Shop staff", "दुकान स्टाफ", "दुकान कर्मचारी"),
  back: L("Back to my shop", "मेरी दुकान पर वापस", "माझ्या दुकानावर परत"),
  noProducts: L("No products yet", "अभी कोई उत्पाद नहीं", "अजून उत्पादने नाहीत"),
  noProductsText: L(
    "Add products to your shop first; each one then appears here for its photo and price.",
    "पहले अपनी दुकान में उत्पाद जोड़ें; फिर हर उत्पाद फ़ोटो और कीमत के लिए यहाँ दिखेगा।",
    "आधी तुमच्या दुकानात उत्पादने जोडा; मग प्रत्येक उत्पादन फोटो आणि किमतीसाठी इथे दिसेल.",
  ),
  add: L("Add products", "उत्पाद जोड़ें", "उत्पादने जोडा"),
} as const;

/**
 * The shop owner's photo catalogue: each product with its photo and price, as
 * customers see them. Photos are added and prices set from the tiles; both go
 * through the same APIs (and checks) as the rest of the shop pages.
 */
export default async function ShopCataloguePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = await activeShop(shops);

  const [tiles, lang] = await Promise.all([listShopPhotoCatalogue(shop.id), getBoardLang()]);
  const withPhoto = tiles.length - tiles.filter(needsPhoto).length;
  const withoutPrice = tiles.filter(needsPrice).length;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={tr(T.title, lang)}
        description={
          tiles.length === 0
            ? tr(T.emptyDesc, lang).replace("{shop}", shop.name)
            : tr(T.desc, lang)
                .replace("{shop}", shop.name)
                .replace("{withPhoto}", String(withPhoto))
                .replace("{total}", String(tiles.length))
                .replace("{noPrice}", withoutPrice > 0 ? tr(T.noPrice, lang).replace("{n}", String(withoutPrice)) : "")
        }
        action={
          <div className="flex flex-wrap gap-2">
            {shop.status === "APPROVED" ? (
              <LinkButton href={`/shops/${shop.slug}`} variant="secondary">
                {tr(T.viewShop, lang)}
              </LinkButton>
            ) : null}
            <LinkButton href="/shop/media-import" variant="secondary">
              {tr(T.bulk, lang)}
            </LinkButton>
            <LinkButton href="/shop/staff" variant="secondary">
              {tr(T.staff, lang)}
            </LinkButton>
            <LinkButton href="/shop" variant="secondary">
              {tr(T.back, lang)}
            </LinkButton>
          </div>
        }
      />
      {tiles.length === 0 ? (
        <EmptyState
          title={tr(T.noProducts, lang)}
          description={tr(T.noProductsText, lang)}
          action={<LinkButton href="/shop">{tr(T.add, lang)}</LinkButton>}
        />
      ) : (
        <PhotoCatalogue tiles={tiles} shopId={shop.id} />
      )}
    </div>
  );
}
