import { inArray } from "drizzle-orm";
import { redirect } from "next/navigation";

import { CartView } from "@/components/cart-view";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listAddresses } from "@/server/services/addresses";
import { COD_LIMITS, getCodEligibility } from "@/server/services/cod";
import { getCart } from "@/server/services/cart";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { getCustomerLocation } from "@/server/location";
import { validateCartForLocation } from "@/server/services/cart-validation";
import { listShopsForOwner } from "@/server/services/shops";
import { getWalletByUserId } from "@/server/services/wallet";

export const metadata = { title: "Cart" };
export const dynamic = "force-dynamic";

export default async function CartPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const canOrderB2B = can(user.role, PERMISSIONS.ORDER_PLACE_B2B);
  const [cart, wallet, addresses, ownedShops, codEligibility] = await Promise.all([
    getCart(user.id),
    getWalletByUserId(user.id),
    listAddresses(user.id),
    canOrderB2B ? listShopsForOwner(user.id) : Promise.resolve([]),
    getCodEligibility(user.id),
  ]);
  // Cart re-validated against the chosen delivery location: shop eligibility,
  // availability, minimum order and delivery charge, each with a suggested
  // action. Checkout enforces the same rules (GS-026).
  const location = await getCustomerLocation(user.id);
  const cartShopIds = cart.groups.map((g) => g.shop.id);
  const cartShops =
    cartShopIds.length > 0 ? await db.select().from(shops).where(inArray(shops.id, cartShopIds)) : [];
  const validation = await validateCartForLocation(user.id, location);
  // GS-030: why cash on delivery is unavailable for this cart, if it is.
  const tooLarge = cart.groups.find((g) => g.totalPaise > codEligibility.maxOrderPaise);
  const noCodShop = cartShops.find((s) => !s.codEnabled || !s.deliveryAvailable);
  const codUnavailableReason = !codEligibility.allowed
    ? codEligibility.reason
    : noCodShop
      ? `${noCodShop.name} does not accept cash on delivery.`
      : tooLarge
        ? `Cash on delivery is available up to ₹${(codEligibility.maxOrderPaise / 100).toFixed(0)} per shop order.`
        : cart.groups.length > COD_LIMITS.maxOpenOrders - codEligibility.openOrders
          ? "Too many cash-on-delivery orders open — pay from your wallet."
          : null;
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
        initialChecks={validation.shops}
        preferredAddressId={preferredAddressId}
        codUnavailableReason={codUnavailableReason}
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
