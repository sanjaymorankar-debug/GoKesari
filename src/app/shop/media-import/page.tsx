import { redirect } from "next/navigation";

import { ShopMediaImport } from "@/components/shop-media-import";
import { LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getRule } from "@/server/services/settings";
import { getMediaImport, listMediaImports } from "@/server/services/shop-media-import";
import { resolveCatalogueShop } from "@/server/services/shop-staff";

export const metadata = { title: "Bulk photos & descriptions" };
export const dynamic = "force-dynamic";

/** Module 1: a ZIP of photos and/or a CSV of descriptions for many products at once. */
export default async function ShopMediaImportPage({
  searchParams,
}: {
  searchParams: Promise<{ shopId?: string; upload?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { shopId, upload } = await searchParams;
  const shop = await resolveCatalogueShop(user, shopId);
  if (!shop) redirect("/shop");

  const [rules, past] = await Promise.all([getRule("shopProductMedia"), listMediaImports(shop.shopId)]);
  const opened = upload && /^[0-9a-f-]{36}$/i.test(upload) ? await getMediaImport(shop.shopId, upload).catch(() => null) : null;
  const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Bulk photos & descriptions"
        description={`${shop.shopName} — upload many products' photos and descriptions at once.`}
        action={
          <LinkButton href={shop.via === "STAFF" ? `/shop/staff-access?shopId=${shop.shopId}` : "/shop/catalogue"} variant="secondary">
            Back
          </LinkButton>
        }
      />
      <ShopMediaImport
        shopId={shop.shopId}
        limits={{ maxPhotos: rules.maxPhotos, zipMaxMb: mb(rules.zipMaxBytes), zipMaxFiles: rules.zipMaxFiles, maxUploadMb: mb(rules.maxUploadBytes) }}
        past={JSON.parse(JSON.stringify(past))}
        initial={opened ? JSON.parse(JSON.stringify(opened)) : null}
      />
    </div>
  );
}
