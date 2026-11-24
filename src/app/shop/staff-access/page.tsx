import Link from "next/link";
import { redirect } from "next/navigation";

import { SafeImage } from "@/components/safe-image";
import { ShopStaffInviteAccept } from "@/components/shop-staff-invite-accept";
import { StaffShopBoard } from "@/components/staff-shop-board";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { SHOP_STAFF_ROLE_LABELS } from "@/lib/shop-staff/permissions";
import { getCurrentUser } from "@/server/authz/guards";
import { listingsContentSummary } from "@/server/services/shop-media";
import { catalogueAccessFor, listMyInvitations, listShopsWhereStaff, myStaffPermissions } from "@/server/services/shop-staff";

export const metadata = { title: "Shops I help with" };
export const dynamic = "force-dynamic";

/**
 * Module 1: the way in for shop staff — the shops they were added to and, for
 * one shop, its products with their photo and description state.
 * Module 10 (flag shop_staff_roles_enabled): open invitations to accept, and
 * for one shop only the sections the person's role allows (StaffShopBoard).
 */
export default async function StaffAccessPage({ searchParams }: { searchParams: Promise<{ shopId?: string; view?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { shopId, view } = await searchParams;
  const [shops, invitations] = await Promise.all([listShopsWhereStaff(user.id), listMyInvitations(user)]);
  const selected = shopId && /^[0-9a-f-]{36}$/i.test(shopId) ? shopId : shops.length === 1 && invitations.length === 0 ? shops[0].shopId : null;

  // Module 10: the person's role in the selected shop (null with the flag off — catalogue only, as before).
  const permissions = selected ? await myStaffPermissions(selected, user.id) : null;
  if (selected && permissions && view !== "catalogue") {
    const shop = shops.find((s) => s.shopId === selected);
    if (!shop) redirect("/shop/staff-access");
    return <StaffShopBoard shopId={selected} shopName={shop.shopName} permissions={permissions} />;
  }

  if (!selected) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Shops I help with" description="Shops whose product photos and descriptions you can edit." />
        {invitations.length > 0 ? (
          <Card className="mb-4 divide-y divide-cream-100">
            {invitations.map((inv) => (
              <div key={inv.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
                <p className="text-ink-900">
                  <span className="font-medium">{inv.shopName}</span> invited you as {SHOP_STAFF_ROLE_LABELS[inv.role]}
                </p>
                <ShopStaffInviteAccept staffId={inv.id} />
              </div>
            ))}
          </Card>
        ) : null}
        {shops.length === 0 ? (
          invitations.length === 0 ? <EmptyState title="No shops yet" description="A shop owner can add you from their Shop staff page." /> : null
        ) : (
          <Card className="divide-y divide-cream-100">
            {shops.map((s) => (
              <Link key={s.shopId} href={`/shop/staff-access?shopId=${s.shopId}`} className="block p-4 text-sm font-medium text-ink-900 hover:bg-cream-50">
                {s.shopName} →
              </Link>
            ))}
          </Card>
        )}
      </div>
    );
  }

  const via = await catalogueAccessFor(selected, user);
  if (!via) redirect("/shop/staff-access");
  const shop = shops.find((s) => s.shopId === selected);
  const listings = await listingsContentSummary(selected);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={shop?.shopName ?? "Shop products"}
        description="Tap a product to change its photos and description."
        action={
          <LinkButton href={`/shop/media-import?shopId=${selected}`} variant="secondary">
            Bulk upload
          </LinkButton>
        }
      />
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {listings.map((l) => (
          <li key={l.id}>
            <Link href={`/shop/products/${l.id}/media`} className="flex items-center gap-3 rounded-xl border border-cream-200 bg-white p-3 hover:bg-cream-50">
              <SafeImage src={l.imageUrl} size="thumb" alt={l.productName} className="h-14 w-14 shrink-0 rounded-lg bg-cream-100 object-cover" />
              <div className="min-w-0 text-sm">
                <p className="truncate font-medium text-ink-900">{l.productName}</p>
                <p className="text-xs text-ink-500">{l.productCode}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge tone={l.ownPhotos > 0 ? "success" : "neutral"}>{l.ownPhotos} photo{l.ownPhotos === 1 ? "" : "s"}</Badge>
                  {l.hasShortDescription || l.hasLongDescription ? <Badge tone="success">Description</Badge> : null}
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
