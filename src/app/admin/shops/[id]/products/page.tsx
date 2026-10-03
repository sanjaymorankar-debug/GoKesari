import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ExcelPriceUpload } from "@/components/excel-price-upload";
import { PendingPriceApprovals } from "@/components/pending-price-approvals";
import { ShopProductManager } from "@/components/shop-product-manager";
import { Badge, ClassificationBadge, PageHeader, Section, StatusBadge } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { shopTypeLabel } from "@/lib/shop-types";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { listShopProducts, suggestProductsForShop } from "@/server/services/catalogue";
import { appliesImmediately, listPendingForShop } from "@/server/services/price-requests";

export const metadata = { title: "Manage Shop Products" };
export const dynamic = "force-dynamic";

/**
 * Admin "Manage Products — [SHOP NAME]" (product management brief).
 *
 * Deliberately reuses `ShopProductManager` and `ExcelPriceUpload` — the exact
 * same components the shop owner's own page renders. Admin acting on another
 * shop is not a parallel product-management system; it is the same system
 * with a different `shopId`, authorized by the `_ANY` permissions that already
 * existed (`requireShopAccess` on every underlying API route is what actually
 * enforces this — this page is a convenience surface, not a new boundary).
 */
export default async function AdminShopProductsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY)) redirect("/");

  const [shop] = await db.select().from(shops).where(eq(shops.id, id)).limit(1);
  if (!shop) notFound();

  const [products, suggestions, pending] = await Promise.all([
    listShopProducts(shop.id),
    suggestProductsForShop(shop.id),
    listPendingForShop(shop.id),
  ]);

  const alreadyListed = new Set(products.map((p) => p.productId));
  const availableToAdd = suggestions.filter((p) => !alreadyListed.has(p.id));
  const immediate = appliesImmediately(user, shop.ownerId);

  return (
    <>
      <PageHeader
        title={`Manage Products — ${shop.name}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{shop.registrationNumber} · {shop.ownerName}</span>
            <Badge>{shopTypeLabel(shop.shopType)}</Badge>
            <ClassificationBadge value={shop.classification} />
            <StatusBadge status={shop.status} />
          </span>
        }
        action={
          <span className="flex gap-4">
            <Link
              href={`/admin/shops/${shop.id}/product-categories`}
              className="text-sm font-medium text-kesari-600 hover:underline"
            >
              Product categories
            </Link>
            <Link
              href="/admin/shops"
              className="text-sm font-medium text-kesari-600 hover:underline"
            >
              ← All shops
            </Link>
          </span>
        }
      />

      {!immediate ? (
        <p className="mb-6 rounded-lg border border-cream-200 bg-cream-50 px-4 py-3 text-sm text-ink-600">
          You are not this shop&apos;s owner, so price changes you make here are
          sent to {shop.ownerName} for approval before going live — the same
          rule that applies everywhere else.
        </p>
      ) : null}

      <Section title={`Pending price approvals (${pending.length})`}>
        <PendingPriceApprovals
          rows={pending.map((r) => ({
            id: r.id,
            productName: r.productName,
            productCode: r.productCode,
            unit: r.unit,
            priceType: r.priceType,
            previousPricePaise: r.previousPricePaise,
            proposedPricePaise: r.proposedPricePaise,
            source: r.source,
            createdAt: r.createdAt.toISOString(),
          }))}
          canOverride={can(user.role, PERMISSIONS.PRICE_REQUEST_OVERRIDE)}
        />
      </Section>

      <Section title="Upload a product list">
        <ExcelPriceUpload shopId={shop.id} appliesImmediately={immediate} uploadType="GOODS" />
      </Section>

      <Section title="Upload a price list">
        <ExcelPriceUpload shopId={shop.id} appliesImmediately={immediate} uploadType="PRICES" />
      </Section>

      <ShopProductManager
        shopId={shop.id}
        department={shop.shopType}
        applyPriceImmediately={immediate}
        products={products.map((p) => ({
          id: p.id,
          productName: p.product.name,
          categoryName: p.category.name,
          unit: p.product.unit,
          onlinePricePaise: p.onlinePricePaise,
          offlinePricePaise: p.offlinePricePaise,
          onlineSaleEnabled: p.onlineSaleEnabled,
          offlineSaleEnabled: p.offlineSaleEnabled,
          onlineStock: p.onlineStock,
          trackInventory: p.trackInventory,
          isActive: p.isActive,
          isAvailable: p.isAvailable,
          paused: p.categoryCarried === false,
        }))}
        suggestions={availableToAdd.map((p) => ({
          id: p.id,
          name: p.name,
          unit: p.unit,
          categoryName: p.category.name,
          department: p.category.department,
        }))}
      />
    </>
  );
}
