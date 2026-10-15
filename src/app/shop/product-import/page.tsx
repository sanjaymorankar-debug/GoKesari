import { redirect } from "next/navigation";

import { SubmenuStrip } from "@/components/board/submenu-strip";
import { ProductImportPanel } from "@/components/product-import-panel";
import { PageHeader } from "@/components/ui";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getBoardLang } from "@/server/board-lang";
import { getImportLimits, listShopImports } from "@/server/services/product-import";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Bulk upload (Excel/CSV)" };
export const dynamic = "force-dynamic";

/** docs/product-import-2026-10: the shop owner's Bulk Upload (Excel/CSV), under Inventory. */
export default async function ShopProductImportPage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.EXCEL_UPLOAD_OWN)) redirect("/shop");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = await activeShop(shops);
  const { job } = await searchParams;

  const [limits, history, lang] = await Promise.all([getImportLimits(), listShopImports(shop.id), getBoardLang()]);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Bulk upload (Excel/CSV)"
        description={`${shop.name} — add or update many products at once and set their stock from one file.`}
      />
      <SubmenuStrip board="shop" menuKey="inventory" role={user.role} lang={lang} current="bulkUpload" />
      <ProductImportPanel
        shopId={shop.id}
        shopName={shop.name}
        limits={{ maxMb: Math.round(limits.maxFileBytes / (1024 * 1024)), maxRows: limits.maxRows, enabled: limits.enabled }}
        initialHistory={JSON.parse(JSON.stringify(history))}
        initialJobId={job && /^[0-9a-f-]{36}$/i.test(job) ? job : null}
      />
    </div>
  );
}
