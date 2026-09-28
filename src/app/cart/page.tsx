import { inArray } from "drizzle-orm";
import { redirect } from "next/navigation";

import { CartView } from "@/components/cart-view";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listAddresses } from "@/server/services/addresses";
import { getCart } from "@/server/services/cart";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { getCustomerLocation } from "@/server/location";
import { shopServiceability } from "@/server/services/serviceability";
import { listShopsForOwner } from "@/server/services/shops";
import { getWalletByUserId } from "@/server/services/wallet";

export const metadata = { title: "Cart" };
export const dynamic = "force-dynamic";

export default async function CartPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const canOrderB2B = can(user.role, PERMISSIONS.ORDER_PLACE_B2B);
  const [cart, wallet, addresses, ownedShops] = await Promise.all([
    getCart(user.id),
    getWalletByUserId(user.id),
    listAddresses(user.id),
    canOrderB2B ? listShopsForOwner(user.id) : Promise.resolve([]),
  ]);
  // Serviceability against the chosen delivery location (GS-004/010). A
  // warning only here — the hard block belongs to checkout (GS-026).
  const location = await getCustomerLocation(user.id);
  const cartShopIds = cart.groups.map((g) => g.shop.id);
  const cartShops =
    location && cartShopIds.length > 0
      ? await db.select().from(shops).where(inArray(shops.id, cartShopIds))
      : [];
  const deliveryWarnings: Record<string, string> = {};
  for (const shop of cartShops) {
    const check = shopServiceability(shop, location!);
    if (!check.deliversHere && check.reason) deliveryWarnings[shop.id] = check.reason;
  }
  const preferredAddressId =
    location?.addressId && addresses.some((a) => a.id === location.addressId)
      ? location.addressId
      : null;

  // Only an approved shop can buy for its business; checkout re-checks this.
  const buyerShops = ownedShops
    .filter((shop) => shop.status === "APPROVED")
    .map((shop) => ({ id: shop.id, name: shop.name }));

  return (
    <>
      <PageHeader
        title="Your cart"
        description="Items are grouped by shop — each shop becomes its own order."
      />
      <CartView
        cart={cart}
        walletBalancePaise={wallet?.balancePaise ?? 0}
        buyerShops={buyerShops}
        deliveryWarnings={deliveryWarnings}
        preferredAddressId={preferredAddressId}
        addresses={addresses.map((a) => ({
          id: a.id,
          label: a.label,
          line1: a.line1,
          area: a.area,
          city: a.city,
          pincode: a.pincode,
          isDefault: a.isDefault,
        }))}
      />
    </>
  );
}
