import { redirect } from "next/navigation";

import { ShopStaffManager } from "@/components/shop-staff-manager";
import { ShopStaffRolesManager } from "@/components/shop-staff-roles-manager";
import { LinkButton, PageHeader } from "@/components/ui";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { listShopStaff } from "@/server/services/shop-staff";
import { shopStaffRolesEnabled } from "@/server/services/shop-staff-access";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Shop staff" };
export const dynamic = "force-dynamic";

/**
 * Module 1: the owner's list of people who may edit the shop's product photos and descriptions.
 * Module 10 (flag shop_staff_roles_enabled): staff with roles — invite, change role, pause, remove, activity.
 */
export default async function ShopStaffPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shop = await activeShop(await listShopsForOwner(user.id));
  if (!shop) redirect("/shop");
  const [staff, rolesOn] = await Promise.all([listShopStaff(shop.id, user), shopStaffRolesEnabled()]);
  return (
    <div className={rolesOn ? "mx-auto max-w-3xl" : "mx-auto max-w-2xl"}>
      <PageHeader
        title="Shop staff"
        description={
          rolesOn
            ? `${shop.name} — people who help run your shop, each with a role. They see and do only what their role allows; every change is recorded with who made it.`
            : `${shop.name} — people who may add and change your product photos and descriptions. Every change is recorded with who made it.`
        }
        action={
          <LinkButton href="/shop/catalogue" variant="secondary">
            Back
          </LinkButton>
        }
      />
      {rolesOn ? (
        <ShopStaffRolesManager shopId={shop.id} staff={JSON.parse(JSON.stringify(staff))} canManageManagers />
      ) : (
        <ShopStaffManager shopId={shop.id} staff={JSON.parse(JSON.stringify(staff))} />
      )}
    </div>
  );
}
