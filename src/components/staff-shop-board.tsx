/**
 * Module 10 (docs/shop-staff-roles-2026-11): a staff member's board for one
 * shop — only the sections their role allows. Server component; every action
 * behind it is checked again by the API (requireShopPermission).
 */
import Link from "next/link";

import { Badge, Card, LinkButton, PageHeader } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import {
  permissionAllows,
  SHOP_STAFF_RESOURCE_LABELS,
  visibleSections,
  type ShopStaffPermission,
  type ShopStaffResource,
} from "@/lib/shop-staff/permissions";
import { getInventoryDashboard } from "@/server/services/inventory-alerts";
import { listOrdersForShop } from "@/server/services/orders";

const SECTION_HINT: Partial<Record<ShopStaffResource, string>> = {
  delivery: "Find a rider, hand over and deliver orders from the order screens.",
  customers: "Customer questions about this shop's orders.",
  billing: "Wallet, payouts, invoices and GST returns.",
  reports: "Sales and order reports.",
  settings: "Shop details and settings.",
  staff: "The shop's staff list.",
};

export async function StaffShopBoard({ shopId, shopName, permissions }: { shopId: string; shopName: string; permissions: ShopStaffPermission[] }) {
  const sections = visibleSections(permissions);
  const has = (s: ShopStaffResource) => sections.includes(s);
  const [orders, inventory] = await Promise.all([
    has("orders") ? listOrdersForShop(shopId, { limit: 20 }) : Promise.resolve(null),
    has("inventory") ? getInventoryDashboard(shopId) : Promise.resolve(null),
  ]);
  const money = permissionAllows(permissions, "financial_visibility");

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title={shopName}
        description="What your role in this shop lets you do."
        action={
          <LinkButton href="/shop/staff-access" variant="secondary">
            All shops
          </LinkButton>
        }
      />
      {sections.length === 0 ? <Card className="p-4 text-sm text-ink-600">Your role does not include any sections yet. Ask the shop owner.</Card> : null}

      {orders ? (
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-semibold text-ink-900">{SHOP_STAFF_RESOURCE_LABELS.orders}</h2>
          {orders.length === 0 ? <p className="text-sm text-ink-500">No orders yet.</p> : null}
          <ul className="divide-y divide-cream-100 text-sm">
            {orders.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-medium text-ink-900">{o.orderNumber}</span>
                <span className="text-xs text-ink-500">{o.items.length} item{o.items.length === 1 ? "" : "s"}</span>
                {money ? <span className="text-xs text-ink-700">{formatPaise(o.totalPaise)}</span> : null}
                <Badge>{o.status}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {has("catalogue") ? (
        <Card className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
          <div>
            <h2 className="font-semibold text-ink-900">{SHOP_STAFF_RESOURCE_LABELS.catalogue}</h2>
            <p className="text-ink-500">Product photos and descriptions.</p>
          </div>
          <div className="flex gap-2">
            <LinkButton href={`/shop/staff-access?shopId=${shopId}&view=catalogue`} variant="secondary">
              Products
            </LinkButton>
            <LinkButton href={`/shop/media-import?shopId=${shopId}`} variant="secondary">
              Bulk upload
            </LinkButton>
          </div>
        </Card>
      ) : null}

      {inventory ? (
        <Card className="p-4 text-sm">
          <h2 className="mb-2 font-semibold text-ink-900">{SHOP_STAFF_RESOURCE_LABELS.inventory}</h2>
          <div className="flex flex-wrap gap-2">
            <Badge>{inventory.totalProducts} products</Badge>
            <Badge tone="success">{inventory.inStock} in stock</Badge>
            <Badge tone="warning">{inventory.lowStock} low</Badge>
            <Badge tone="danger">{inventory.outOfStock} out of stock</Badge>
            <Badge tone="info">{inventory.reorderRequired} to reorder</Badge>
          </div>
        </Card>
      ) : null}

      {sections
        .filter((s) => s !== "orders" && s !== "catalogue" && s !== "inventory")
        .map((s) => (
          <Card key={s} className="p-4 text-sm">
            <h2 className="font-semibold text-ink-900">{SHOP_STAFF_RESOURCE_LABELS[s]}</h2>
            <p className="text-ink-500">{SECTION_HINT[s]}</p>
          </Card>
        ))}

      <p className="text-xs text-ink-500">
        Your access is checked on every request: if the owner changes or pauses it, it applies at once.{" "}
        <Link href="/notifications" className="underline">
          Notifications
        </Link>
      </p>
    </div>
  );
}
