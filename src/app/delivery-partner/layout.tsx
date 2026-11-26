import { RiderBottomNav } from "@/components/rider-bottom-nav";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";

/**
 * Delivery partner pages: a phone tab bar for people who are delivery partners
 * (docs/ux-mobile-2026-11). Each page still runs its own sign-in and checks;
 * this layout only decides, best-effort, whether the bar shows.
 */
export default async function DeliveryPartnerLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const [partner, lang] = user
    ? await Promise.all([getMyDeliveryPartnerProfile(user.id).catch(() => null), getBoardLang()])
    : [null, null];
  return (
    <>
      {children}
      {partner && lang ? <RiderBottomNav lang={lang} approved={partner.status === "APPROVED"} /> : null}
    </>
  );
}
