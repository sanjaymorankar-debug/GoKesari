import { and, asc, eq, isNull } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { ShopPhotoListing } from "@/components/shop-photo-listing";
import { Alert, LinkButton, PageHeader } from "@/components/ui";
import { tr, L } from "@/lib/board/i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getBoardLang } from "@/server/board-lang";
import { db } from "@/server/db";
import { productCategories, shops } from "@/server/db/schema";
import { isFeatureEnabledForShop } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";
import { PHOTO_LISTING_FLAG, shopLocalLang } from "@/server/services/shop-photo-listing";
import { resolveCatalogueShop } from "@/server/services/shop-staff";

export const metadata = { title: "Add product by photo" };
export const dynamic = "force-dynamic";

const TITLE = L("Add product by photo", "फ़ोटो से उत्पाद जोड़ें", "फोटोने उत्पादन जोडा");
const DESCRIPTION = L(
  "Take 1–4 photos, say the price and stock, check and publish.",
  "1–4 फ़ोटो लें, कीमत और स्टॉक बोलें, जाँचें और प्रकाशित करें।",
  "1–4 फोटो काढा, किंमत आणि साठा सांगा, तपासा आणि प्रसिद्ध करा.",
);
const OWNER_ONLY = L(
  "Only the shop's owner can add products by photo.",
  "फ़ोटो से उत्पाद केवल दुकान के मालिक जोड़ सकते हैं।",
  "फोटोने उत्पादन फक्त दुकानाचे मालक जोडू शकतात.",
);

/** docs/smart-shopping-2026-11/FEATURE2_PRODUCT_BY_PHOTO.md — hidden (404) while shop_photo_listing_enabled is off. */
export default async function ShopPhotoListingPage({ searchParams }: { searchParams: Promise<{ shopId?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { shopId } = await searchParams;
  const resolved = await resolveCatalogueShop(user, shopId);
  if (!resolved) redirect("/shop");
  const [shop] = await db
    .select({ id: shops.id, pincode: shops.pincode, state: shops.state })
    .from(shops)
    .where(and(eq(shops.id, resolved.shopId), isNull(shops.deletedAt)));
  if (!shop || !(await isFeatureEnabledForShop(PHOTO_LISTING_FLAG, shop))) notFound();
  const lang = await getBoardLang();
  const allowed = resolved.via === "OWNER" || can(user.role, PERMISSIONS.PRODUCT_CREATE_ANY);

  const [rule, categories] = await Promise.all([
    getRule("smartShopping"),
    db
      .select({ id: productCategories.id, name: productCategories.name })
      .from(productCategories)
      .where(and(isNull(productCategories.deletedAt), eq(productCategories.isActive, true)))
      .orderBy(asc(productCategories.sortOrder), asc(productCategories.name)),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={tr(TITLE, lang)}
        description={`${resolved.shopName} — ${tr(DESCRIPTION, lang)}`}
        action={
          <LinkButton href="/shop/inventory" variant="secondary">
            {lang === "en" ? "Back" : lang === "hi" ? "वापस" : "मागे"}
          </LinkButton>
        }
      />
      {allowed ? (
        <ShopPhotoListing
          shopId={resolved.shopId}
          lang={lang}
          localLang={shopLocalLang(shop)}
          categories={categories}
          limits={{ maxPhotos: rule.maxPhotosPerProduct, maxUploadMb: rule.maxUploadMb, lowConfidenceBelow: rule.lowConfidenceBelow }}
        />
      ) : (
        <Alert tone="warning">{tr(OWNER_ONLY, lang)}</Alert>
      )}
    </div>
  );
}
