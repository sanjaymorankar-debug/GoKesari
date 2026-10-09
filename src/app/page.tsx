import { cookies } from "next/headers";

import { CustomerBoard } from "@/components/board/customer-board";
import { REFERRAL_COOKIE } from "@/lib/customer-referrals";
import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/server/authz/guards";
import { loadCustomerBoard } from "@/server/board-data";
import { getBoardHeaderData } from "@/server/board-header-data";
import { getBoardLang } from "@/server/board-lang";
import { getCustomerLocation } from "@/server/location";
import { canApplyReferralCode } from "@/server/services/customer-referrals";

export const dynamic = "force-dynamic";

/**
 * Marketplace home (requirement §6): the customer Tile Board — search,
 * "Do now", categories, every menu and the cart, all on one screen. What
 * the old home page held below its first screen has a home of its own:
 * shops near you → Shops (/shops), price comparison → Shops › Compare prices
 * (/search/compare), tomorrow's delivery → Subscriptions › Tomorrow, the two
 * sign-up cards → the visitor's "Join" row, the invite prompt → "Do now".
 */
export default async function HomePage() {
  const user = await getCurrentUser();
  const location = await getCustomerLocation(user?.id);
  // F11: arrived through a friend's referral link and not yet applied — prompt once signed in.
  const referralCode = (await cookies()).get(REFERRAL_COOKIE)?.value;
  const showReferral = user && referralCode ? await canApplyReferralCode(user.id).catch(() => false) : false;

  const [lang, header, board] = await Promise.all([getBoardLang(), getBoardHeaderData(user), loadCustomerBoard(user, location)]);

  return (
    <CustomerBoard
      lang={lang}
      user={user}
      header={header}
      data={board}
      timeZone={getEnv().APP_TIMEZONE}
      referralCode={showReferral ? referralCode : null}
    />
  );
}
