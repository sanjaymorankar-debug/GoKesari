import { redirect } from "next/navigation";

import { ShopStaffManager } from "@/components/shop-staff-manager";
import { LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listShopStaff } from "@/server/services/shop-staff";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Shop staff" };
export const dynamic = "force-dynamic";

/** Module 1: the owner's list of people who may edit the shop's product photos and descriptions. */
export default async function ShopStaffPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const [shop] = await listShopsForOwner(user.id);
  if (!shop) redirect("/shop");
  const staff = await listShopStaff(shop.id, user);
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Shop staff"
        description={`${shop.name} — people who may add and change your product photos and descriptions. Every change is recorded with who made it.`}
        action={
          <LinkButton href="/shop/catalogue" variant="secondary">
            Back
          </LinkButton>
        }
      />
      <ShopStaffManager shopId={shop.id} staff={JSON.parse(JSON.stringify(staff))} />
    </div>
  );
}
