import { redirect } from "next/navigation";
import { L, tr } from "@/lib/board/i18n";
import { getBoardLang } from "@/server/board-lang";

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
const T = {
  title: L("Shop staff", "दुकान स्टाफ", "दुकान कर्मचारी"),
  description: L(
    "{shop} — people who may add and change your product photos and descriptions. Every change is recorded with who made it.",
    "{shop} — वे लोग जो आपके उत्पादों की फ़ोटो और विवरण जोड़ और बदल सकते हैं। हर बदलाव किसने किया, यह दर्ज होता है।",
    "{shop} — तुमच्या उत्पादनांचे फोटो आणि वर्णन जोडू व बदलू शकणारे लोक. प्रत्येक बदल कोणी केला हे नोंदवले जाते.",
  ),
  descriptionRoles: L(
    "{shop} — people who help run your shop, each with a role. They see and do only what their role allows; every change is recorded with who made it.",
    "{shop} — वे लोग जो दुकान चलाने में मदद करते हैं, हर एक की अपनी भूमिका है। वे सिर्फ़ वही देखते और करते हैं जिसकी उनकी भूमिका अनुमति देती है; हर बदलाव किसने किया, यह दर्ज होता है।",
    "{shop} — दुकान चालवण्यात मदत करणारे लोक, प्रत्येकाची स्वतःची भूमिका. त्यांची भूमिका परवानगी देते तेवढेच ते पाहतात आणि करतात; प्रत्येक बदल कोणी केला हे नोंदवले जाते.",
  ),
  back: L("Back", "वापस", "मागे"),
} as const;

export default async function ShopStaffPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shop = await activeShop(await listShopsForOwner(user.id));
  if (!shop) redirect("/shop");
  const [staff, rolesOn, lang] = await Promise.all([listShopStaff(shop.id, user), shopStaffRolesEnabled(), getBoardLang()]);
  return (
    <div className={rolesOn ? "mx-auto max-w-3xl" : "mx-auto max-w-2xl"}>
      <PageHeader
        title={tr(T.title, lang)}
        description={tr(rolesOn ? T.descriptionRoles : T.description, lang).replace("{shop}", shop.name)}
        action={
          <LinkButton href="/shop/catalogue" variant="secondary">
            {tr(T.back, lang)}
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
