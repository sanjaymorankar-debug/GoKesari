import { redirect } from "next/navigation";

import { ShopDeliveryPartners } from "@/components/shop-delivery-partners";
import { EmptyState, PageHeader } from "@/components/ui";
import { vehicleTypeLabel } from "@/lib/vehicle-types";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { listShopsForOwner } from "@/server/services/shops";
import { listShopDeliveryPartners } from "@/server/services/society-partner-access";

export const metadata = { title: "Delivery partners" };
export const dynamic = "force-dynamic";

/** Gig worker flow (feature 7): GoKesari partners who carried this shop's orders, with their authorised and blocked societies. */
export default async function ShopDeliveryPartnersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = await activeShop(shops);
  const partners = await listShopDeliveryPartners(shop.id, user);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Delivery partners"
        description={`GoKesari delivery partners who carried ${shop.name}'s orders in the last 90 days, and the societies that authorise or block each of them.`}
      />
      {partners.length === 0 ? (
        <EmptyState title="No delivery partners yet." description="Partners appear here once they have picked up one of your orders." />
      ) : (
        <ShopDeliveryPartners
          partners={partners.map((p) => ({
            deliveryPartnerId: p.deliveryPartnerId,
            riderId: p.riderId,
            name: p.name,
            photoUrl: p.photoUrl,
            vehicleLabel: vehicleTypeLabel(p.vehicleType),
            ordersDelivered: p.ordersDelivered,
            lastOrderAt: p.lastOrderAt.toISOString(),
            authorised: p.authorised.map((s) => ({ societyId: s.societyId, name: s.name, area: s.area, city: s.city })),
            blocked: p.blocked.map((s) => ({ societyId: s.societyId, name: s.name, area: s.area, city: s.city })),
          }))}
        />
      )}
    </div>
  );
}
