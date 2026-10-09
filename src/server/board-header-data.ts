/**
 * Data for the Tile Board's compact header — the same sources the root layout
 * reads for the site header, each best-effort so the header always renders.
 */
import { shortLocationLabel } from "@/lib/location";
import type { AuthenticatedUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
import { listAddresses } from "@/server/services/addresses";
import { unreadCount } from "@/server/services/notifications";
import { listUserRoles } from "@/server/services/roles";
import { getRule } from "@/server/services/settings";
import { listShopsWhereStaff } from "@/server/services/shop-staff";
import { getWalletByUserId } from "@/server/services/wallet";

export interface BoardHeaderData {
  roles: string[];
  unread: number;
  balancePaise: number | null;
  locationLabel: string | null;
  savedAddresses: { id: string; label: string }[];
  extraLinks: { href: string; label: string }[];
}

export async function getBoardHeaderData(user: AuthenticatedUser | null): Promise<BoardHeaderData> {
  const location = await getCustomerLocation(user?.id).catch(() => null);
  if (!user) {
    return {
      roles: [],
      unread: 0,
      balancePaise: null,
      locationLabel: location ? shortLocationLabel(location) : null,
      savedAddresses: [],
      extraLinks: [],
    };
  }
  const [roles, unread, balancePaise, addresses, staffShops, referralLinks] = await Promise.all([
    listUserRoles(user.id).catch(() => [user.role]),
    unreadCount(user.id).catch(() => 0),
    // No wallet row is a balance of zero; a failed read hides the balance rather than showing ₹0.
    getWalletByUserId(user.id)
      .then((w) => w?.balancePaise ?? 0)
      .catch(() => null),
    listAddresses(user.id).catch(() => []),
    listShopsWhereStaff(user.id).catch(() => []),
    Promise.all([getRule("customerSignupReferral"), getRule("customerReferrals")])
      .then(([signup, friends]) => [
        ...(signup.enabled ? [{ href: "/referral", label: "My referral code" }] : []),
        ...(friends.enabled ? [{ href: "/refer", label: "Invite friends" }] : []),
      ])
      .catch(() => []),
  ]);
  return {
    roles,
    unread,
    balancePaise,
    locationLabel: location ? shortLocationLabel(location) : null,
    savedAddresses: addresses.map((a) => ({ id: a.id, label: `${a.label ? `${a.label} — ` : ""}${a.pincode}` })),
    extraLinks: [...(staffShops.length > 0 ? [{ href: "/shop/staff-access", label: "Shops I help with" }] : []), ...referralLinks],
  };
}
