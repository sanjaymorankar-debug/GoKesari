import Link from "next/link";
import { redirect } from "next/navigation";

import { SafeImage } from "@/components/safe-image";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listingsContentSummary } from "@/server/services/shop-media";
import { catalogueAccessFor, listShopsWhereStaff } from "@/server/services/shop-staff";

export const metadata = { title: "Shops I help with" };
export const dynamic = "force-dynamic";

/**
 * Module 1: the way in for shop staff — the shops they were added to and, for
 * one shop, its products with their photo and description state.
 */
export default async function StaffAccessPage({ searchParams }: { searchParams: Promise<{ shopId?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { shopId } = await searchParams;
  const shops = await listShopsWhereStaff(user.id);
  const selected = shopId && /^[0-9a-f-]{36}$/i.test(shopId) ? shopId : shops.length === 1 ? shops[0].shopId : null;

  if (!selected) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Shops I help with" description="Shops whose product photos and descriptions you can edit." />
        {shops.length === 0 ? (
          <EmptyState title="No shops yet" description="A shop owner can add you from their Shop staff page." />
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
