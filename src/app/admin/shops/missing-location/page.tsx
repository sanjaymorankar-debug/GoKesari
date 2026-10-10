import Link from "next/link";
import { redirect } from "next/navigation";

import { ShopsMissingLocation } from "@/components/shops-missing-location";
import { PageHeader } from "@/components/ui";
import { isGeocodingConfigured } from "@/lib/env";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { shopsMissingLocation } from "@/server/services/nearby-shops";

export const metadata = { title: "Shops without location" };
export const dynamic = "force-dynamic";

/** Shops left out of Nearby for want of a map location (docs/nearby-referral-2026-10, feature 1). */
export default async function ShopsMissingLocationPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_APPROVE)) redirect("/");
  const shops = await shopsMissingLocation();
  const live = shops.filter((s) => s.status === "APPROVED").length;
  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/admin/menu/shops" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Shops
      </Link>
      <PageHeader
        title="Shops without location"
        description={`Nearby lists shops by their map location, so these ${shops.length} shop${shops.length === 1 ? " is" : "s are"} left out of it (${live} live). Fix the location and the shop appears in Nearby at once.`}
      />
      <ShopsMissingLocation
        shops={shops.map((s) => ({
          id: s.id,
          name: s.name,
          registrationNumber: s.registrationNumber,
          status: s.status,
          problem: s.problem,
          addressLine1: s.addressLine1,
          area: s.area,
          city: s.city,
          pincode: s.pincode,
          latitude: s.latitude,
          longitude: s.longitude,
        }))}
        canEdit={can(user.role, PERMISSIONS.SHOP_UPDATE_ANY)}
        geocoding={isGeocodingConfigured()}
      />
    </div>
  );
}
