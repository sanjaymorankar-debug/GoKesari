import { redirect } from "next/navigation";

import { ProductImportPanel } from "@/components/product-import-panel";
import { ProductImportShopPicker } from "@/components/product-import-shop-picker";
import { LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getImportLimits, listShopImports, searchShopsForImport } from "@/server/services/product-import";
import { getShopById } from "@/server/services/shops";

export const metadata = { title: "Bulk product upload" };
export const dynamic = "force-dynamic";

/** docs/product-import-2026-10: operators and admins upload products for any shop, chosen here. */
export default async function AdminProductImportPage({ searchParams }: { searchParams: Promise<{ shopId?: string; job?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.EXCEL_UPLOAD_ANY)) redirect("/");
  const { shopId, job } = await searchParams;
  const shop = shopId && /^[0-9a-f-]{36}$/i.test(shopId) ? ((await getShopById(shopId).catch(() => undefined)) ?? null) : null;
  const limits = await getImportLimits();

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Bulk upload (Excel/CSV)"
        description="Upload an Amazon Seller Central inventory file, the GoKesari template or a CSV for any shop. Operators' prices go to the shop owner for approval; stock and listings are updated at once."
        action={shop ? <LinkButton href="/admin/product-import" variant="secondary">Choose another shop</LinkButton> : undefined}
      />
      {shop ? (
        <ProductImportPanel
          shopId={shop.id}
          shopName={shop.name}
          limits={{ maxMb: Math.round(limits.maxFileBytes / (1024 * 1024)), maxRows: limits.maxRows, enabled: limits.enabled }}
          initialHistory={JSON.parse(JSON.stringify(await listShopImports(shop.id)))}
          initialJobId={job && /^[0-9a-f-]{36}$/i.test(job) ? job : null}
        />
      ) : (
        <ProductImportShopPicker initial={await searchShopsForImport("")} />
      )}
    </div>
  );
}
