/** docs/referral-sharing-2026-11: the shop-owner code a /r/ link left in this browser (cookie gk_ref_link), when it still works. */
import { cookies } from "next/headers";

import { REFERRAL_LINK_COOKIE } from "@/lib/customer-referrals";
import { getCurrentUser } from "@/server/authz/guards";
import { referralSharingOn, resolveReferralLink } from "./referral-links";

export async function sharedShopCode(): Promise<string | null> {
  if (!(await referralSharingOn())) return null;
  const code = (await cookies()).get(REFERRAL_LINK_COOKIE)?.value;
  if (!code) return null;
  const target = await resolveReferralLink(code);
  if (!target.usable || target.audience !== "shop-owner") return null;
  const user = await getCurrentUser();
  return user && target.referrerUserId === user.id ? null : target.code;
}
